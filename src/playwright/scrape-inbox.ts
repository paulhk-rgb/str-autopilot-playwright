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

async function listInboxThreadIds(page: Page, max: number): Promise<string[]> {
  await page.goto('https://www.airbnb.com/hosting/messages', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  // Inbox starts behind a `[data-testid="inbox-list-loader"]` spinner.
  // Wait for it to detach OR an inbox row to appear. Either resolution
  // means the SPA finished its initial fetch.
  await Promise.race([
    page
      .waitForSelector('a[data-testid^="inbox_list_"]', { timeout: 45_000 })
      .catch(() => undefined),
    page
      .waitForSelector('[data-testid="inbox-list-loader"]', {
        state: 'detached',
        timeout: 45_000,
      })
      .catch(() => undefined),
  ]);
  // Brief settle so DOM mounts after loader detach
  await page.waitForTimeout(1500);

  // Diagnostic snapshot — surfaces redirect destinations + DOM availability
  // when scraper returns zero threads. Logged to stdout (Fly logs).
  const diag = await page.evaluate(() => {
    type EL = { getAttribute(n: string): string | null };
    const doc = (globalThis as unknown as {
      document: {
        title: string;
        body: { innerText: string };
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
    return {
      url: w.href,
      title: doc.title,
      inboxLinks: doc.querySelectorAll('a[data-testid^="inbox_list_"]').length,
      anyAnchors: doc.querySelectorAll('a').length,
      anyDataTestIds: testIdEls.length,
      sampleTestIds: testIds,
      bodyText: (doc.body?.innerText || '').slice(0, 800),
    };
  });
  console.log('[scrape-inbox] inbox-page diag:', JSON.stringify(diag));
  // Echo into a side-channel global so the handler can include in response.
  (globalThis as unknown as { __lastInboxDiag?: unknown }).__lastInboxDiag = diag;

  const ids = await page.evaluate(() => {
    type EL = { getAttribute(n: string): string | null };
    type Doc = { querySelectorAll(sel: string): { forEach(cb: (el: EL) => void): void } };
    const doc = (globalThis as unknown as { document: Doc }).document;
    const out: string[] = [];
    doc.querySelectorAll('a[data-testid^="inbox_list_"]').forEach((el) => {
      const t = el.getAttribute('data-testid') || '';
      const id = t.replace('inbox_list_', '');
      if (id) out.push(id);
    });
    return out;
  });

  // Dedup while preserving order; cap to budget.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length >= max) break;
  }
  return unique;
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
    let threadIds: string[] = [];
    try {
      threadIds = await listInboxThreadIds(page, budget.maxThreads);
    } catch (err) {
      errors.push(`inbox_list_failed: ${err instanceof Error ? err.message : String(err)}`);
      return { messages: out, bookingsFound: 0, errors };
    }

    for (const threadId of threadIds) {
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
