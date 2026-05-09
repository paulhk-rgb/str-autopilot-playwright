/**
 * Airbnb hosting inbox scraper.
 *
 * Walks the hosting inbox sidebar to enumerate thread IDs, then opens each
 * thread and parses the message list via aria-label introspection — same
 * pattern proven in ~/google-scripts/airbnb/playwright-sender/airbnb-sender.js
 * `readConversation()` (in production against Paul's account since 2026).
 *
 * DOM contract (verified 2026-04):
 *   - Inbox sidebar entries: a[data-testid^="inbox_list_<threadId>"]
 *   - Thread URL:            /hosting/messages/<threadId>
 *   - Message list:          [data-testid="message-list"]
 *   - Message group:         [data-testid="message-list"] > div[role="group"]
 *   - Group aria-label:      "<Name> sent <text>. Sent <timestamp>."
 *                            "Airbnb service says <text>. Sent <timestamp>."
 *
 * `airbnb_message_id` is synthesized as a stable hash of
 * (threadId, sender, timestamp, content) since Airbnb does not expose a
 * stable per-message DOM id. Identical message in same thread/timestamp
 * dedups correctly across reruns; that's the contract `messages.airbnb_message_id`
 * relies on for sync_messages_batch.
 */

import { createHash } from 'crypto';
import type { BrowserContext, Page } from 'playwright';

export interface ScrapedMessage {
  airbnb_message_id: string;
  content: string;
  sender: 'guest' | 'host';
  timestamp: string; // ISO8601 — best-effort; Airbnb's aria-label is relative ("2 days ago")
  conversation_airbnb_id: string;
  guest_name?: string;
  listing_name?: string;
  check_in?: string;
  check_out?: string;
  stay_text?: string;
}

interface ParsedGroup {
  senderType: 'guest' | 'host' | 'system';
  senderName: string;
  text: string;
  timestamp: string;
  dateHeading: string;
}

export interface ScrapeOptions {
  mode: 'initial' | 'incremental' | 'full';
  since?: string;
  /** Account display name treated as `host` (everyone else is `guest`). */
  hostDisplayName?: string;
}

interface ScrapeBudget {
  maxThreads: number;
  maxMessagesPerThread: number;
}

interface InboxThreadSummary {
  threadId: string;
  guestName?: string;
  listingName?: string;
  checkIn?: string;
  checkOut?: string;
  stayText?: string;
}

interface InboxPageDiag {
  url: string;
  title: string;
  inboxLinks: number;
  anyAnchors: number;
  anyDataTestIds: number;
  loaderPresent: boolean;
  emptyStateVisible: boolean;
  sampleTestIds: string[];
  bodyText: string;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const MONTH_PATTERN =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const EMPTY_INBOX_TEXT_PATTERN_SOURCE =
  "\\b(no messages|no conversations|all caught up|don['’]t have any messages|do not have any messages|you have no messages)\\b";
const EMPTY_INBOX_TEXT_PATTERN = new RegExp(EMPTY_INBOX_TEXT_PATTERN_SOURCE, 'i');

function normalizeSidebarText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function isSidebarNoiseLine(line: string): boolean {
  return (
    /^(confirmed|currently hosting|pending|canceled|cancelled|unread|leave a review|message)$/i.test(line) ||
    /^(inquiry|request to book|pre-approved|preapproved|declined|expired|action required)$/i.test(line) ||
    /^\d{1,2}:\d{2}\s?(am|pm)$/i.test(line) ||
    /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(line) ||
    /^you:/i.test(line) ||
    /^airbnb update:/i.test(line)
  );
}

function firstLikelyGuestName(raw: string): string | undefined {
  for (const line of normalizeSidebarText(raw).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || isSidebarNoiseLine(trimmed)) continue;
    if (new RegExp(`\\b(?:${MONTH_PATTERN})\\s+\\d{1,2}\\b`, 'i').test(trimmed)) continue;
    return trimmed.slice(0, 120);
  }
  return undefined;
}

function monthIndex(name: string): number | undefined {
  return MONTH_INDEX[name.toLowerCase()];
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function inferCheckInYear(month: number, day: number, now: Date): number | null {
  const year = now.getFullYear();
  const candidate = new Date(Date.UTC(year, month, day));
  // Airbnb sidebar rows usually omit the year. If a parsed date would land
  // more than roughly six months in the future, treat the year as ambiguous
  // rather than risking a wrong-stay link to either prior-year or far-future data.
  const maxFutureMs = 180 * 24 * 60 * 60 * 1000;
  const delta = candidate.getTime() - now.getTime();
  if (delta > maxFutureMs) return null;
  if (delta < -maxFutureMs) {
    const nextYearCandidate = new Date(Date.UTC(year + 1, month, day));
    if (nextYearCandidate.getTime() - now.getTime() <= maxFutureMs) {
      return year + 1;
    }
    return null;
  }
  return year;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  const dt = new Date(Date.UTC(year, month, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month &&
    dt.getUTCDate() === day
  );
}

function likelyListingFromTail(tail: string): string | undefined {
  const parts = tail
    .split(/[·•\n]/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (isSidebarNoiseLine(part)) continue;
    if (/^\d+\s+(adult|adults|guest|guests|infant|infants|night|nights)\b/i.test(part)) continue;
    if (/^(inbox|read|sent|booker)$/i.test(part)) continue;
    if (/^\d{1,2}:\d{2}\s?(am|pm)$/i.test(part)) continue;
    return part.slice(0, 200);
  }

  return undefined;
}

function isExplicitEmptyInboxText(bodyText: string): boolean {
  return EMPTY_INBOX_TEXT_PATTERN.test(bodyText);
}

function parseInboxThreadSummary(
  threadId: string,
  rawText: string,
  now: Date = new Date(),
): InboxThreadSummary {
  const raw = normalizeSidebarText(rawText);
  const summary: InboxThreadSummary = {
    threadId,
    guestName: firstLikelyGuestName(raw),
  };

  const datePattern = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?\\s*(?:-|–|—|to)\\s*(?:(${MONTH_PATTERN})\\s+)?(\\d{1,2})(?:,?\\s*(\\d{4}))?`,
    'i',
  );
  const match = raw.match(datePattern);
  if (!match || match.index === undefined) return summary;

  const startMonth = monthIndex(match[1]);
  const startDay = Number(match[2]);
  const startYearExplicit = match[3] ? Number(match[3]) : undefined;
  const endMonth = monthIndex(match[4] || match[1]);
  const endDay = Number(match[5]);
  const endYearExplicit = match[6] ? Number(match[6]) : undefined;
  if (startMonth === undefined || endMonth === undefined || !startDay || !endDay) {
    return summary;
  }

  summary.stayText = match[0].replace(/\s+/g, ' ').trim();
  summary.listingName = likelyListingFromTail(raw.slice(match.index + match[0].length));

  let checkInYear: number | null;
  let checkOutYear: number;
  if (startYearExplicit && endYearExplicit) {
    checkInYear = startYearExplicit;
    checkOutYear = endYearExplicit;
  } else if (endYearExplicit) {
    checkOutYear = endYearExplicit;
    checkInYear = endMonth < startMonth ? endYearExplicit - 1 : endYearExplicit;
  } else if (startYearExplicit) {
    checkInYear = startYearExplicit;
    checkOutYear = startYearExplicit;
  } else {
    checkInYear = inferCheckInYear(startMonth, startDay, now);
    if (checkInYear === null) return summary;
    checkOutYear = checkInYear;
  }

  if (
    !endYearExplicit &&
    (endMonth < startMonth || (endMonth === startMonth && endDay < startDay))
  ) {
    checkOutYear += 1;
  }

  if (
    !isValidDateParts(checkInYear, startMonth, startDay) ||
    !isValidDateParts(checkOutYear, endMonth, endDay)
  ) {
    return summary;
  }

  summary.checkIn = isoDate(checkInYear, startMonth, startDay);
  summary.checkOut = isoDate(checkOutYear, endMonth, endDay);

  return summary;
}

function budgetFor(mode: ScrapeOptions['mode']): ScrapeBudget {
  switch (mode) {
    case 'incremental':
      return { maxThreads: 10, maxMessagesPerThread: 20 };
    case 'full':
      return { maxThreads: 100, maxMessagesPerThread: 100 };
    case 'initial':
    default:
      return { maxThreads: 30, maxMessagesPerThread: 50 };
  }
}

function stableMessageId(
  threadId: string,
  senderName: string,
  timestamp: string,
  text: string,
): string {
  const h = createHash('sha256');
  h.update(threadId);
  h.update('|');
  h.update(senderName);
  h.update('|');
  h.update(timestamp);
  h.update('|');
  h.update(text);
  return h.digest('hex').slice(0, 32);
}

async function collectInboxDiag(page: Page): Promise<InboxPageDiag> {
  return page.evaluate((emptyInboxTextPatternSource) => {
    type EL = { getAttribute(n: string): string | null; textContent?: string | null };
    const doc = (globalThis as unknown as {
      document: {
        title: string;
        body: { innerText: string };
        querySelector(sel: string): EL | null;
        querySelectorAll(sel: string): ArrayLike<EL> & { length: number };
      };
    }).document;
    const w = (globalThis as unknown as { location: { href: string } }).location;
    const testIdEls = doc.querySelectorAll('[data-testid]');
    const testIds: string[] = [];
    for (let i = 0; i < testIdEls.length && testIds.length < 40; i++) {
      const v = testIdEls[i].getAttribute('data-testid');
      if (v) testIds.push(v);
    }
    const inboxPanelText =
      doc.querySelector('[data-testid="inbox-container-marker"]')?.textContent || '';
    const emptyPattern = new RegExp(emptyInboxTextPatternSource, 'i');
    return {
      url: w.href,
      title: doc.title,
      inboxLinks: doc.querySelectorAll('a[data-testid^="inbox_list_"]').length,
      anyAnchors: doc.querySelectorAll('a').length,
      anyDataTestIds: testIdEls.length,
      loaderPresent: Boolean(doc.querySelector('[data-testid="inbox-list-loader"]')),
      emptyStateVisible: emptyPattern.test(inboxPanelText),
      sampleTestIds: testIds,
      bodyText: (doc.body?.innerText || '').slice(0, 800),
    };
  }, EMPTY_INBOX_TEXT_PATTERN_SOURCE);
}

async function readRawInboxThreads(page: Page): Promise<Array<{ id: string; text: string }>> {
  return page.evaluate(() => {
    type EL = {
      getAttribute(n: string): string | null;
      textContent: string | null;
      innerText?: string;
    };
    type Doc = { querySelectorAll(sel: string): { forEach(cb: (el: EL) => void): void } };
    const doc = (globalThis as unknown as { document: Doc }).document;
    const out: Array<{ id: string; text: string }> = [];
    doc.querySelectorAll('a[data-testid^="inbox_list_"]').forEach((el) => {
      const t = el.getAttribute('data-testid') || '';
      const id = t.replace('inbox_list_', '');
      if (id) out.push({ id, text: el.innerText || el.textContent || '' });
    });
    return out;
  });
}

async function waitForInboxRowsOrEmpty(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForFunction(
      (emptyInboxTextPatternSource) => {
        type WaitDoc = {
          body?: { innerText?: string };
          querySelector(sel: string): { textContent?: string | null } | null;
          querySelectorAll(sel: string): { length: number };
        };
        const doc = (globalThis as unknown as { document: WaitDoc }).document;
        if (doc.querySelectorAll('a[data-testid^="inbox_list_"]').length > 0) return true;
        const inboxPanelText =
          doc.querySelector('[data-testid="inbox-container-marker"]')?.textContent || '';
        return new RegExp(emptyInboxTextPatternSource, 'i').test(inboxPanelText);
      },
      EMPTY_INBOX_TEXT_PATTERN_SOURCE,
      { timeout: timeoutMs },
    )
    .catch(() => undefined);
}

function logInboxDiag(diag: InboxPageDiag): void {
  console.log('[scrape-inbox] inbox-page diag:', JSON.stringify(diag));
  // Echo into a side-channel global so the handler can include in response.
  (globalThis as unknown as { __lastInboxDiag?: unknown }).__lastInboxDiag = diag;
}

async function gotoInbox(page: Page): Promise<void> {
  try {
    await page.goto('https://www.airbnb.com/hosting/messages', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch (err) {
    const currentUrl = page.url();
    if (!/\/hosting\/messages(?:\/|$|\?)/.test(currentUrl)) {
      throw err;
    }
    console.warn('[scrape-inbox] inbox navigation timed out after reaching messages page', {
      url: currentUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function listInboxThreads(page: Page, max: number): Promise<InboxThreadSummary[]> {
  let lastDiag: InboxPageDiag | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 1) {
      await gotoInbox(page);
    } else {
      console.warn('[scrape-inbox] retrying inbox list after unloaded sidebar', {
        prior_url: lastDiag?.url,
        prior_loader_present: lastDiag?.loaderPresent,
        prior_inbox_links: lastDiag?.inboxLinks,
      });
      const reloadError = await page
        .reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        .then(() => null)
        .catch((err) => err);
      if (reloadError) {
        console.warn('[scrape-inbox] inbox reload failed before retry', {
          error: reloadError instanceof Error ? reloadError.message : String(reloadError),
        });
      }
    }

    // Airbnb's sidebar can sit behind `[data-testid="inbox-list-loader"]`.
    // Wait for actual rows or an explicit empty state; loader disappearance
    // alone is not enough because we observed production returning a bare
    // shell (`Messages` + loader) that would otherwise be mistaken for success.
    await waitForInboxRowsOrEmpty(page, attempt === 1 ? 45_000 : 15_000);
    await page.waitForTimeout(1500);

    lastDiag = await collectInboxDiag(page);
    logInboxDiag(lastDiag);

    if (lastDiag.inboxLinks === 0) {
      if (lastDiag.emptyStateVisible) {
        return [];
      }
      continue;
    }

    const threads = await readRawInboxThreads(page);

    // Dedup while preserving order; cap to budget.
    const seen = new Set<string>();
    const unique: InboxThreadSummary[] = [];
    for (const thread of threads) {
      const id = thread.id;
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(parseInboxThreadSummary(id, thread.text));
      if (unique.length >= max) break;
    }

    if (unique.length > 0) return unique;
    console.warn('[scrape-inbox] inbox anchors rendered without readable thread ids', {
      anchor_count: lastDiag.inboxLinks,
      raw_thread_count: threads.length,
    });
  }

  const diag = lastDiag;
  throw new Error(
    [
      'inbox_list_unavailable',
      diag ? `url=${diag.url}` : null,
      diag ? `loader=${diag.loaderPresent}` : null,
      diag ? `links=${diag.inboxLinks}` : null,
      diag ? `anchors=${diag.anyAnchors}` : null,
      diag ? `testids=${diag.anyDataTestIds}` : null,
    ]
      .filter(Boolean)
      .join(':'),
  );
}

async function readThread(
  page: Page,
  threadId: string,
  msgLimit: number,
): Promise<ParsedGroup[]> {
  await page.goto(`https://www.airbnb.com/hosting/messages/${threadId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  const ready = await page
    .waitForSelector('[data-testid="message-list"]', { timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    // One reload retry — Airbnb's SPA sometimes drops the message list on first nav.
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('[data-testid="message-list"]', { timeout: 12_000 });
    } catch {
      return [];
    }
  }

  return page.evaluate((limit) => {
    type GroupOut = {
      senderType: 'guest' | 'host' | 'system';
      senderName: string;
      text: string;
      timestamp: string;
      dateHeading: string;
    };
    type EL = {
      getAttribute(n: string): string | null;
      querySelector(sel: string): { textContent: string | null } | null;
    };
    type Doc = { querySelectorAll(sel: string): ArrayLike<EL> };
    const doc = (globalThis as unknown as { document: Doc }).document;
    const groups: EL[] = Array.from(
      doc.querySelectorAll('[data-testid="message-list"] > div[role="group"]'),
    );
    const parsed: GroupOut[] = [];
    for (const g of groups) {
      const aria = g.getAttribute('aria-label') || '';
      if (!aria) continue;

      let senderType: GroupOut['senderType'] = 'guest';
      let senderName = '';
      let text = '';
      let timestamp = '';

      if (aria.startsWith('Airbnb service says')) {
        const m = aria.match(/Airbnb service says (.+?)(?:\. Sent (.+?))?\.?$/);
        senderType = 'system';
        senderName = 'Airbnb';
        text = m?.[1] ?? aria;
        timestamp = m?.[2] ?? '';
      } else {
        const m = aria.match(/(\w[\w\s]*?) sent (.+?)(?:\. Sent (.+?))?\.?$/);
        if (!m) continue;
        senderName = m[1].trim();
        text = m[2];
        timestamp = m[3] ?? '';
        // Host vs guest classification is done by the caller (knows account name).
        senderType = 'guest';
      }

      if (text.endsWith(' .')) text = text.slice(0, -2);

      const heading = g.querySelector('h2');
      const dateHeading = heading?.textContent ?? '';

      parsed.push({ senderType, senderName, text, timestamp, dateHeading });
    }
    return parsed.slice(-limit);
  }, msgLimit);
}

/**
 * Best-effort relative-time → ISO8601. Airbnb's aria-label timestamps are
 * "2 days ago", "5 hours ago", "Apr 23 at 3:14 PM". Parse what we can; fall
 * back to "now" so the message still ingests (timestamp ordering is downstream
 * concern — the `airbnb_message_id` hash dedups regardless).
 */
function parseRelativeTimestamp(s: string, now: Date = new Date()): string {
  if (!s) return now.toISOString();
  const trimmed = s.trim();

  const rel = trimmed.match(/^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms =
      unit === 'minute' ? n * 60_000
      : unit === 'hour' ? n * 3_600_000
      : unit === 'day' ? n * 86_400_000
      : unit === 'week' ? n * 7 * 86_400_000
      : n * 30 * 86_400_000;
    return new Date(now.getTime() - ms).toISOString();
  }

  if (/^just now$/i.test(trimmed) || /^a few seconds ago$/i.test(trimmed)) {
    return now.toISOString();
  }

  // Try native Date.parse for absolute formats.
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return new Date(ts).toISOString();
  }

  // Unknown format — emit current time + leave the raw label as the
  // de-dup hash input, so re-runs with the same label still match.
  return now.toISOString();
}

export async function scrapeInbox(
  ctx: BrowserContext,
  opts: ScrapeOptions,
): Promise<{
  messages: ScrapedMessage[];
  bookingsFound: number;
  errors: string[];
}> {
  const budget = budgetFor(opts.mode);
  const errors: string[] = [];
  const out: ScrapedMessage[] = [];

  const page = await ctx.newPage();
  try {
    let threads: InboxThreadSummary[] = [];
    try {
      threads = await listInboxThreads(page, budget.maxThreads);
    } catch (err) {
      errors.push(`inbox_list_failed: ${err instanceof Error ? err.message : String(err)}`);
      return { messages: out, bookingsFound: 0, errors };
    }

    for (const thread of threads) {
      const threadId = thread.threadId;
      try {
        const groups = await readThread(page, threadId, budget.maxMessagesPerThread);
        for (const g of groups) {
          if (g.senderType === 'system') continue; // Airbnb-service messages are noise for now.
          const sender: 'guest' | 'host' =
            opts.hostDisplayName && g.senderName === opts.hostDisplayName ? 'host' : 'guest';
          const ts = parseRelativeTimestamp(g.timestamp);
          out.push({
            airbnb_message_id: stableMessageId(threadId, g.senderName, g.timestamp, g.text),
            content: g.text,
            sender,
            timestamp: ts,
            conversation_airbnb_id: threadId,
            guest_name: thread.guestName,
            listing_name: thread.listingName,
            check_in: thread.checkIn,
            check_out: thread.checkOut,
            stay_text: thread.stayText,
          });
        }
      } catch (err) {
        errors.push(
          `thread_${threadId}_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  return { messages: out, bookingsFound: 0, errors };
}

export const __scrapeInboxTestHooks = {
  parseInboxThreadSummary,
  isExplicitEmptyInboxText,
  listInboxThreads,
};
