import type { BrowserContext, Locator, Page } from 'playwright';
import { openPage } from './browser';
import { buildMulticalendarUrl } from './scrape-calendar-prices';

export interface BrowserSetMinimumStaysDateRequest {
  date: string;
  plan_id: string;
  plan_version: number;
  min_stay: number;
}

export interface BrowserSetMinimumStaysRequest {
  schema_version: 1;
  host_id: string;
  property_id: string;
  listing_id: string;
  currency: string;
  idempotency_key: string;
  dry_run: boolean;
  dates: BrowserSetMinimumStaysDateRequest[];
}

export type BrowserSetMinimumStayDateStatus =
  | 'applied'
  | 'already_set'
  | 'validated'
  | 'skipped'
  | 'failed'
  | 'ambiguous';

export type BrowserSetMinimumStayReasonCode =
  | 'blocked_by_airbnb'
  | 'blocked_date'
  | 'booked_date'
  | 'date_click_failed'
  | 'date_missing'
  | 'invalid_cookies'
  | 'listing_mismatch'
  | 'no_dates_found'
  | 'save_clicked_readback_failed'
  | 'sidebar_close_failed'
  | 'value_mismatch_after_save'
  | 'worker_failed_or_missing_verification';

export interface BrowserSetMinimumStayDateResult {
  date: string;
  status: BrowserSetMinimumStayDateStatus;
  verified: boolean;
  requested_min_stay: number;
  observed_min_stay?: number;
  previous_min_stay?: number;
  currency: string;
  is_booked?: boolean;
  is_blocked?: boolean;
  reason?: BrowserSetMinimumStayReasonCode;
}

export interface BrowserSetMinimumStaysResult {
  success: boolean;
  schema_version: 1;
  host_id: string;
  listing_id: string;
  currency: string;
  dry_run: boolean;
  session_listing_verified: boolean;
  smart_pricing_enabled: false;
  results: BrowserSetMinimumStayDateResult[];
}

export class BrowserSetMinimumStaysError extends Error {
  constructor(
    public readonly code:
      | 'blocked_by_airbnb'
      | 'invalid_cookies'
      | 'listing_mismatch'
      | 'no_dates_found',
    message = code,
  ) {
    super(message);
    this.name = 'BrowserSetMinimumStaysError';
  }
}

const CALENDAR_READY_TIMEOUT_MS = 20_000;
const SIDEBAR_SELECTOR = '#HOST-CALENDAR-SIDEBAR-CONTAINER';
const MINIMUM_STAY_SECTION_SELECTOR = '[data-testid="pna-trip-length"], [data-testid="pna-minimum-stay"]';
const MINIMUM_STAY_INPUT_SELECTORS = [
  '#PriceInput-minimumStay',
  'input[name="minimumStay"]',
  'input[aria-label*="minimum"]',
  'input[aria-label*="Minimum"]',
] as const;
const MINIMUM_STAY_SAVE_SELECTORS = [
  '[data-testid="minimumStayForm-submit"]',
  '[data-testid="tripLengthForm-submit"]',
] as const;

export async function setCalendarMinimumStays(
  ctx: BrowserContext,
  opts: {
    request: BrowserSetMinimumStaysRequest;
    waitAfterLoadMs?: number;
    clickDelayMs?: number;
  },
): Promise<BrowserSetMinimumStaysResult> {
  const request = normalizeBrowserSetMinimumStaysRequest(opts.request);
  const page = await openPage(ctx);
  const results: BrowserSetMinimumStayDateResult[] = [];

  try {
    await gotoWithRetry(page, buildMulticalendarUrl(request.listing_id));
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(opts.waitAfterLoadMs ?? 2_000);

    if (isLoginUrl(page.url())) {
      throw new BrowserSetMinimumStaysError('invalid_cookies');
    }
    if (await isBlockedPage(page)) {
      throw new BrowserSetMinimumStaysError('blocked_by_airbnb');
    }

    await waitForCalendarReady(page);
    assertCalendarUrlMatchesListing(page.url(), request.listing_id);

    for (const [index, entry] of request.dates.entries()) {
      assertCalendarUrlMatchesListing(page.url(), request.listing_id);
      let result: BrowserSetMinimumStayDateResult;
      try {
        result = await setSingleCalendarMinimumStay(page, {
          entry,
          currency: request.currency,
          dryRun: request.dry_run,
          clickDelayMs: opts.clickDelayMs ?? 800,
        });
      } catch (err) {
        if (
          err instanceof BrowserSetMinimumStaysError &&
          (err.code === 'invalid_cookies' || err.code === 'blocked_by_airbnb') &&
          results.length > 0
        ) {
          for (const remaining of request.dates.slice(index)) {
            results.push({
              date: remaining.date,
              status: 'ambiguous',
              verified: false,
              requested_min_stay: remaining.min_stay,
              currency: request.currency,
              reason: err.code,
            });
          }
          break;
        }
        throw err;
      }

      results.push(result);
      if (result.status === 'ambiguous' && result.reason === 'sidebar_close_failed') {
        for (const remaining of request.dates.slice(index + 1)) {
          results.push({
            date: remaining.date,
            status: 'ambiguous',
            verified: false,
            requested_min_stay: remaining.min_stay,
            currency: request.currency,
            reason: 'sidebar_close_failed',
          });
        }
        break;
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  if (results.length === 0) {
    throw new BrowserSetMinimumStaysError('no_dates_found');
  }

  return {
    success: results.every((result) => ['applied', 'already_set', 'validated', 'skipped'].includes(result.status)),
    schema_version: 1,
    host_id: request.host_id,
    listing_id: request.listing_id,
    currency: request.currency,
    dry_run: request.dry_run,
    session_listing_verified: true,
    smart_pricing_enabled: false,
    results,
  };
}

async function setSingleCalendarMinimumStay(
  page: Page,
  opts: {
    entry: BrowserSetMinimumStaysDateRequest;
    currency: string;
    dryRun: boolean;
    clickDelayMs: number;
  },
): Promise<BrowserSetMinimumStayDateResult> {
  let clickedSave = false;
  const base = {
    date: opts.entry.date,
    requested_min_stay: opts.entry.min_stay,
    currency: opts.currency,
  };

  try {
    assertStillAuthenticated(page);
    const cell = await findDateCell(page, opts.entry.date);
    if (!cell) {
      return { ...base, status: 'failed', verified: false, reason: 'date_missing' };
    }

    if (!await clickDateCell(page, cell)) {
      return { ...base, status: 'failed', verified: false, reason: 'date_click_failed' };
    }
    await page.waitForTimeout(opts.clickDelayMs);
    assertStillAuthenticated(page);
    if (await isBlockedPage(page)) {
      throw new BrowserSetMinimumStaysError('blocked_by_airbnb');
    }

    const sidebarText = normalizeWhitespace(await waitForSidebarText(page));
    const state = classifyDateState(sidebarText);
    if (state === 'booked' || state === 'blocked') {
      await closeSidebar(page);
      return {
        ...base,
        status: 'skipped',
        verified: false,
        is_booked: state === 'booked',
        is_blocked: state === 'blocked',
        reason: state === 'booked' ? 'booked_date' : 'blocked_date',
      };
    }

    if (!await openMinimumStayEditor(page)) {
      await closeSidebar(page);
      return { ...base, status: 'failed', verified: false, reason: 'worker_failed_or_missing_verification' };
    }

    const input = await findMinimumStayInput(page);
    if (!input) {
      await closeSidebar(page);
      return { ...base, status: 'failed', verified: false, reason: 'worker_failed_or_missing_verification' };
    }

    const previousMinStay = parseMinimumStay(await input.inputValue({ timeout: 3_000 }).catch(() => ''));

    if (opts.dryRun) {
      await closeSidebar(page);
      return {
        ...base,
        status: 'validated',
        verified: true,
        observed_min_stay: previousMinStay ?? undefined,
        previous_min_stay: previousMinStay ?? undefined,
      };
    }

    if (previousMinStay === opts.entry.min_stay) {
      await closeSidebar(page);
      return {
        ...base,
        status: 'already_set',
        verified: true,
        observed_min_stay: opts.entry.min_stay,
        previous_min_stay: previousMinStay,
      };
    }

    if (!await typeMinimumStay(input, opts.entry.min_stay)) {
      await closeSidebar(page);
      return {
        ...base,
        status: 'failed',
        verified: false,
        previous_min_stay: previousMinStay ?? undefined,
        reason: 'worker_failed_or_missing_verification',
      };
    }

    clickedSave = await clickEnabledMinimumStaySave(page);
    if (!clickedSave) {
      await closeSidebar(page);
      return {
        ...base,
        status: 'failed',
        verified: false,
        previous_min_stay: previousMinStay ?? undefined,
        reason: 'worker_failed_or_missing_verification',
      };
    }

    await page.waitForTimeout(2_000);
    const readback = await readBackSavedMinimumStay(page, opts.entry.date, opts.clickDelayMs);
    if (!readback.closedBeforeReadback) {
      return {
        ...base,
        status: 'ambiguous',
        verified: false,
        previous_min_stay: previousMinStay ?? undefined,
        reason: 'sidebar_close_failed',
      };
    }

    if (readback.observedMinStay === opts.entry.min_stay) {
      await closeSidebar(page);
      return {
        ...base,
        status: 'applied',
        verified: true,
        previous_min_stay: previousMinStay ?? undefined,
        observed_min_stay: readback.observedMinStay,
      };
    }

    await closeSidebar(page);
    return {
      ...base,
      status: 'ambiguous',
      verified: false,
      previous_min_stay: previousMinStay ?? undefined,
      observed_min_stay: readback.observedMinStay ?? undefined,
      reason: readback.observedMinStay === null ? 'save_clicked_readback_failed' : 'value_mismatch_after_save',
    };
  } catch (err) {
    if (err instanceof BrowserSetMinimumStaysError) {
      throw err;
    }
    await closeSidebar(page).catch(() => false);
    return {
      ...base,
      status: clickedSave ? 'ambiguous' : 'failed',
      verified: false,
      reason: clickedSave ? 'save_clicked_readback_failed' : 'worker_failed_or_missing_verification',
    };
  }
}

function normalizeBrowserSetMinimumStaysRequest(
  request: BrowserSetMinimumStaysRequest,
): BrowserSetMinimumStaysRequest {
  return {
    ...request,
    listing_id: request.listing_id.trim(),
    currency: request.currency.trim().toUpperCase(),
    dates: [...request.dates].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function findDateCell(page: Page, date: string): Promise<Locator | null> {
  const selector = `[data-date="${date}"]`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const cell = page.locator(selector).first();
    if (await cell.count().catch(() => 0)) {
      return cell;
    }
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
      if (scroller) {
        scroller.scrollBy(0, 500);
      } else {
        window.scrollBy(0, 500);
      }
    }).catch(() => undefined);
    await page.waitForTimeout(attempt === 0 ? 1_000 : 500);
  }
  return null;
}

async function clickDateCell(page: Page, cell: Locator): Promise<boolean> {
  try {
    await cell.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    await cell.click({ timeout: 5_000 });
    return true;
  } catch {
    try {
      const date = await cell.evaluate((node) => (node as HTMLElement).getAttribute('data-date'));
      if (!date) return false;
      await page.evaluate((selector) => {
        const node = document.querySelector(selector);
        if (node instanceof HTMLElement) {
          node.scrollIntoView({ block: 'center' });
          node.click();
        }
      }, `[data-date="${date}"]`);
      return true;
    } catch {
      return false;
    }
  }
}

async function openMinimumStayEditor(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await findMinimumStayInput(page)) return true;

    const section = page.locator(`${SIDEBAR_SELECTOR} ${MINIMUM_STAY_SECTION_SELECTOR}`).first();
    if (await section.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await section.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      if (await findMinimumStayInput(page)) return true;
    }

    const expanded = await clickMinimumStayTextMatch(page);
    if (expanded) {
      await page.waitForTimeout(1_500);
      if (await findMinimumStayInput(page)) return true;
    }

    await page.waitForTimeout(800);
  }
  return false;
}

async function clickMinimumStayTextMatch(page: Page): Promise<boolean> {
  return page.evaluate((sidebarSelector) => {
    const sidebar = document.querySelector(sidebarSelector);
    if (!(sidebar instanceof HTMLElement)) return false;
    const clickables = sidebar.querySelectorAll('a, button, [role="button"], div[tabindex="0"], span[role="button"]');
    for (const el of Array.from(clickables)) {
      if (!(el instanceof HTMLElement)) continue;
      const text = (el.innerText || el.textContent || '').toLowerCase();
      if (
        text.includes('custom settings') ||
        text.includes('trip length') ||
        text.includes('minimum stay') ||
        text.includes('minimum nights')
      ) {
        el.click();
        return true;
      }
    }
    return false;
  }, SIDEBAR_SELECTOR).catch(() => false);
}

async function findMinimumStayInput(page: Page): Promise<Locator | null> {
  for (const selector of MINIMUM_STAY_INPUT_SELECTORS) {
    const input = page.locator(selector).first();
    if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
      return input;
    }
  }

  const generatedSelector = await page.evaluate((sidebarSelector) => {
    const sidebar = document.querySelector(sidebarSelector);
    if (!(sidebar instanceof HTMLElement)) return null;
    const inputs = sidebar.querySelectorAll('input[type="number"], input[type="text"], input[inputmode="numeric"]');
    for (const input of Array.from(inputs)) {
      if (!(input instanceof HTMLInputElement)) continue;
      const id = input.id || '';
      const name = input.name || '';
      const label = input.getAttribute('aria-label') || '';
      const placeholder = input.placeholder || '';
      const fingerprint = `${id} ${name} ${label} ${placeholder}`.toLowerCase();
      if (fingerprint.includes('nightlyprice') || (fingerprint.includes('price') && !fingerprint.includes('minimum'))) {
        continue;
      }
      if (
        fingerprint.includes('minimum') ||
        fingerprint.includes('minstay') ||
        fingerprint.includes('triplength') ||
        fingerprint.includes('night')
      ) {
        return id ? `#${CSS.escape(id)}` : null;
      }
    }
    if (inputs.length === 2) {
      for (const input of Array.from(inputs)) {
        if (!(input instanceof HTMLInputElement)) continue;
        const id = input.id || '';
        if (!id.toLowerCase().includes('price')) {
          return id ? `#${CSS.escape(id)}` : null;
        }
      }
    }
    return null;
  }, SIDEBAR_SELECTOR).catch(() => null);

  if (!generatedSelector) return null;
  const input = page.locator(generatedSelector).first();
  return await input.isVisible({ timeout: 500 }).catch(() => false) ? input : null;
}

async function typeMinimumStay(input: Locator, minStay: number): Promise<boolean> {
  const minStayText = String(minStay);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await input.click({ clickCount: 3, timeout: 5_000 });
      await input.fill(minStayText, { timeout: 5_000 });
      if (parseMinimumStay(await input.inputValue({ timeout: 2_000 }).catch(() => '')) === minStay) {
        return true;
      }
    } catch {
      // Retry once below.
    }
  }
  return false;
}

async function clickEnabledMinimumStaySave(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const selector of MINIMUM_STAY_SAVE_SELECTORS) {
      const save = page.locator(selector).first();
      const visible = await save.isVisible({ timeout: 700 }).catch(() => false);
      const enabled = visible && await save.isEnabled({ timeout: 500 }).catch(() => false);
      if (enabled) {
        await save.click({ timeout: 5_000 });
        return true;
      }
    }

    const clicked = await page.evaluate((sidebarSelector) => {
      const sidebar = document.querySelector(sidebarSelector);
      if (!(sidebar instanceof HTMLElement)) return false;
      const buttons = sidebar.querySelectorAll('button[type="submit"], button');
      for (const button of Array.from(buttons)) {
        if (!(button instanceof HTMLButtonElement)) continue;
        const text = (button.innerText || button.textContent || '').trim();
        if (text === 'Save' && !button.disabled) {
          button.click();
          return true;
        }
      }
      return false;
    }, SIDEBAR_SELECTOR).catch(() => false);
    if (clicked) return true;

    await page.waitForTimeout(700);
  }
  return false;
}

async function readBackSavedMinimumStay(
  page: Page,
  date: string,
  clickDelayMs: number,
): Promise<{ closedBeforeReadback: boolean; observedMinStay: number | null }> {
  const closed = await closeSidebar(page);
  if (!closed) {
    return { closedBeforeReadback: false, observedMinStay: null };
  }
  const cell = await findDateCell(page, date);
  if (!cell) {
    return { closedBeforeReadback: true, observedMinStay: null };
  }
  if (!await clickDateCell(page, cell)) {
    return { closedBeforeReadback: true, observedMinStay: null };
  }
  await page.waitForTimeout(clickDelayMs);
  if (!await openMinimumStayEditor(page)) {
    return { closedBeforeReadback: true, observedMinStay: parseMinimumStay(await readSidebarText(page)) };
  }
  const input = await findMinimumStayInput(page);
  if (!input) {
    return { closedBeforeReadback: true, observedMinStay: parseMinimumStay(await readSidebarText(page)) };
  }
  return {
    closedBeforeReadback: true,
    observedMinStay: parseMinimumStay(await input.inputValue({ timeout: 3_000 }).catch(() => '')),
  };
}

async function readSidebarText(page: Page): Promise<string> {
  const sidebar = page.locator(SIDEBAR_SELECTOR).first();
  if (!(await sidebar.count().catch(() => 0))) return '';
  return sidebar.innerText({ timeout: 3_000 }).catch(() => '');
}

async function waitForSidebarText(page: Page, timeoutMs = 6_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = normalizeWhitespace(await readSidebarText(page));
    if (text) return text;
    await page.waitForTimeout(300);
  }
  return normalizeWhitespace(await readSidebarText(page));
}

async function closeSidebar(page: Page): Promise<boolean> {
  const sidebar = page.locator(SIDEBAR_SELECTOR).first();
  if (!(await sidebar.count().catch(() => 0))) return true;
  const closeButton = sidebar.locator('button[aria-label="Close"]').first();
  if (await closeButton.count().catch(() => 0)) {
    await closeButton.click({ timeout: 2_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(800);
  return sidebarHidden(page);
}

async function sidebarHidden(page: Page): Promise<boolean> {
  return page.evaluate((selector) => {
    const sidebar = document.querySelector(selector);
    if (!(sidebar instanceof HTMLElement)) return true;
    return sidebar.offsetParent === null || sidebar.children.length === 0;
  }, SIDEBAR_SELECTOR).catch(() => false);
}

async function gotoWithRetry(page: Page, url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('ERR_ABORTED') && !message.includes('Timeout')) {
        throw err;
      }
      await page.waitForTimeout(1_000 + attempt * 1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForCalendarReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-date]', { timeout: CALENDAR_READY_TIMEOUT_MS }).catch(() => undefined);
}

async function isBlockedPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const body = document.body ? document.body.innerText.toLowerCase() : '';
    return body.includes('verify you are a human') ||
      body.includes('captcha') ||
      body.includes('press and hold') ||
      body.includes('access denied') ||
      body.includes('request blocked') ||
      body.includes('you have been blocked');
  });
}

function isLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('airbnb.com') && parsed.pathname.includes('/login');
  } catch {
    return false;
  }
}

function assertStillAuthenticated(page: Page): void {
  if (isLoginUrl(page.url())) {
    throw new BrowserSetMinimumStaysError('invalid_cookies');
  }
}

function assertCalendarUrlMatchesListing(url: string, listingId: string): void {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const queryListingId =
      parsed.searchParams.get('listing_id') ??
      parsed.searchParams.get('listingId') ??
      parsed.searchParams.get('id');
    const pathHasListingId = pathParts.includes(listingId);
    const queryHasListingId = queryListingId === listingId;
    if (parsed.hostname.endsWith('airbnb.com') && (pathHasListingId || queryHasListingId)) {
      return;
    }
  } catch {
    // Fall through to the same fail-closed mismatch error.
  }
  throw new BrowserSetMinimumStaysError('listing_mismatch');
}

function classifyDateState(text: string): 'booked' | 'blocked' | 'open' {
  const normalized = text.toLowerCase();
  if (
    normalized.includes('currently hosting') ||
    normalized.includes('arrives in') ||
    normalized.includes('checking out') ||
    normalized.includes('guest checked in') ||
    normalized.includes('confirmation code') ||
    /\bcheck-?in\b/.test(normalized) && /\bcheck-?out\b/.test(normalized) && /\bguest\b/.test(normalized)
  ) {
    return 'booked';
  }
  if (
    normalized.includes('blocked') ||
    normalized.includes('not available') ||
    normalized.includes('unavailable')
  ) {
    return 'blocked';
  }
  return 'open';
}

function parseMinimumStay(text: string): number | null {
  const normalized = normalizeWhitespace(text);
  if (/^\d{1,2}$/.test(normalized)) {
    const value = Number(normalized);
    return value >= 1 && value <= 30 ? value : null;
  }

  const patterns = [
    /\bminimum(?: stay| nights?)?\D{0,30}(\d{1,2})\s*(?:night|nights|n)\b/i,
    /\btrip length\D{0,30}(\d{1,2})\s*(?:night|nights|n)\b/i,
    /\b(\d{1,2})\s*(?:night|nights|n)\b\D{0,30}\bminimum\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value >= 1 && value <= 30) {
      return value;
    }
  }

  return null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export const __setMinimumStaysBrowserTestHooks = {
  classifyDateState,
  normalizeBrowserSetMinimumStaysRequest,
  parseMinimumStay,
};
