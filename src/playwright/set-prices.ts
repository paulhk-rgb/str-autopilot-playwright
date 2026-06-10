import type { BrowserContext, Locator, Page } from 'playwright';
import { openPage } from './browser';
import { gotoWithRetry } from './navigation';
import { buildMulticalendarUrl } from './scrape-calendar-prices';

export interface BrowserSetPricesDateRequest {
  date: string;
  plan_id: string;
  plan_version: number;
  price: number;
}

export interface BrowserSetPricesRequest {
  schema_version: 1;
  host_id: string;
  property_id: string;
  listing_id: string;
  currency: string;
  idempotency_key: string;
  dry_run: boolean;
  price_bounds: {
    min: number;
    max: number;
    currency: string;
  };
  dates: BrowserSetPricesDateRequest[];
}

export type BrowserSetPriceDateStatus =
  | 'applied'
  | 'already_set'
  | 'validated'
  | 'skipped'
  | 'rejected'
  | 'failed'
  | 'ambiguous';

export type BrowserSetPriceReasonCode =
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
  | 'smart_pricing_enabled_or_unverified'
  | 'smart_pricing_modal_unknown'
  | 'value_mismatch_after_save'
  | 'worker_failed_or_missing_verification';

export interface BrowserSetPriceDateResult {
  date: string;
  status: BrowserSetPriceDateStatus;
  verified: boolean;
  requested_price: number;
  observed_price?: number;
  previous_price?: number;
  currency: string;
  is_booked?: boolean;
  is_blocked?: boolean;
  reason?: BrowserSetPriceReasonCode;
}

export interface BrowserSetPricesResult {
  success: boolean;
  schema_version: 1;
  host_id: string;
  listing_id: string;
  currency: string;
  dry_run: boolean;
  session_listing_verified: boolean;
  smart_pricing_enabled: boolean;
  results: BrowserSetPriceDateResult[];
}

export class BrowserSetPricesError extends Error {
  constructor(
    public readonly code:
      | 'blocked_by_airbnb'
      | 'invalid_cookies'
      | 'listing_mismatch'
      | 'no_dates_found',
    message = code,
  ) {
    super(message);
    this.name = 'BrowserSetPricesError';
  }
}

const CALENDAR_READY_TIMEOUT_MS = 20_000;
const PRICE_SECTION_SELECTOR = '[data-testid="pna-price"]';
const PRICE_INPUT_SELECTOR = '#PriceInput-nightlyPrice';
const SAVE_BUTTON_SELECTOR = '[data-testid="nightlyPriceForm-submit"]';
const SIDEBAR_SELECTOR = '#HOST-CALENDAR-SIDEBAR-CONTAINER';

export async function setCalendarPrices(
  ctx: BrowserContext,
  opts: {
    request: BrowserSetPricesRequest;
    allowSmartPricingToggle?: boolean;
    waitAfterLoadMs?: number;
    clickDelayMs?: number;
  },
): Promise<BrowserSetPricesResult> {
  const request = normalizeBrowserSetPricesRequest(opts.request);
  const page = await openPage(ctx);
  const results: BrowserSetPriceDateResult[] = [];
  let sawSmartPricingOn = false;

  try {
    await gotoWithRetry(page, buildMulticalendarUrl(request.listing_id), {
      urlIncludes: `/multicalendar/${request.listing_id}`,
      readySelector: '[data-date]',
    });
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(opts.waitAfterLoadMs ?? 2_000);

    if (isLoginUrl(page.url())) {
      throw new BrowserSetPricesError('invalid_cookies');
    }
    if (await isBlockedPage(page)) {
      throw new BrowserSetPricesError('blocked_by_airbnb');
    }

    await waitForCalendarReady(page);
    assertCalendarUrlMatchesListing(page.url(), request.listing_id);

    for (const [index, entry] of request.dates.entries()) {
      assertCalendarUrlMatchesListing(page.url(), request.listing_id);
      let outcome: { result: BrowserSetPriceDateResult; smartPricingOn: boolean };
      try {
        outcome = await setSingleCalendarPrice(page, {
          entry,
          currency: request.currency,
          dryRun: request.dry_run,
          allowSmartPricingToggle: opts.allowSmartPricingToggle === true,
          clickDelayMs: opts.clickDelayMs ?? 800,
        });
      } catch (err) {
        if (
          err instanceof BrowserSetPricesError &&
          (err.code === 'invalid_cookies' || err.code === 'blocked_by_airbnb') &&
          results.length > 0
        ) {
          for (const remaining of request.dates.slice(index)) {
            results.push({
              date: remaining.date,
              status: 'ambiguous',
              verified: false,
              requested_price: remaining.price,
              currency: request.currency,
              reason: err.code,
            });
          }
          break;
        }
        throw err;
      }
      results.push(outcome.result);
      if (outcome.smartPricingOn) {
        sawSmartPricingOn = true;
      }
      if (outcome.result.status === 'ambiguous' && outcome.result.reason === 'sidebar_close_failed') {
        for (const remaining of request.dates.slice(index + 1)) {
          results.push({
            date: remaining.date,
            status: 'ambiguous',
            verified: false,
            requested_price: remaining.price,
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
    throw new BrowserSetPricesError('no_dates_found');
  }

  return {
    success: results.every((result) => ['applied', 'already_set', 'validated', 'skipped'].includes(result.status)),
    schema_version: 1,
    host_id: request.host_id,
    listing_id: request.listing_id,
    currency: request.currency,
    dry_run: request.dry_run,
    session_listing_verified: true,
    smart_pricing_enabled: sawSmartPricingOn,
    results,
  };
}

async function setSingleCalendarPrice(
  page: Page,
  opts: {
    entry: BrowserSetPricesDateRequest;
    currency: string;
    dryRun: boolean;
    allowSmartPricingToggle: boolean;
    clickDelayMs: number;
  },
): Promise<{ result: BrowserSetPriceDateResult; smartPricingOn: boolean }> {
  let clickedSave = false;
  const base = {
    date: opts.entry.date,
    requested_price: opts.entry.price,
    currency: opts.currency,
  };

  try {
    assertStillAuthenticated(page);
    const cell = await findDateCell(page, opts.entry.date);
    if (!cell) {
      return {
        result: {
          ...base,
          status: 'failed',
          verified: false,
          reason: 'date_missing',
        },
        smartPricingOn: false,
      };
    }

    const clickOk = await clickDateCell(page, cell);
    if (!clickOk) {
      return {
        result: {
          ...base,
          status: 'failed',
          verified: false,
          reason: 'date_click_failed',
        },
        smartPricingOn: false,
      };
    }
    await page.waitForTimeout(opts.clickDelayMs);
    assertStillAuthenticated(page);
    if (await isBlockedPage(page)) {
      throw new BrowserSetPricesError('blocked_by_airbnb');
    }

    const sidebarText = normalizeWhitespace(await waitForSidebarText(page));
    const state = classifyDateState(sidebarText);
    if (state === 'booked' || state === 'blocked') {
      await closeSidebar(page);
      return {
        result: {
          ...base,
          status: 'skipped',
          verified: false,
          is_booked: state === 'booked',
          is_blocked: state === 'blocked',
          reason: state === 'booked' ? 'booked_date' : 'blocked_date',
        },
        smartPricingOn: false,
      };
    }

    const priceEditor = await openPriceEditor(page);
    if (!priceEditor) {
      await closeSidebar(page);
      return {
        result: {
          ...base,
          status: 'failed',
          verified: false,
          reason: 'worker_failed_or_missing_verification',
        },
        smartPricingOn: false,
      };
    }

    const smartPricingState = await readSmartPricingEnabled(page);
    if (smartPricingState !== false) {
      if (smartPricingState === true && opts.allowSmartPricingToggle) {
        const toggled = await turnOffSmartPricing(page);
        if (!toggled) {
          await closeSidebar(page);
          return {
            result: {
              ...base,
              status: 'rejected',
              verified: false,
              reason: 'smart_pricing_modal_unknown',
            },
            smartPricingOn: true,
          };
        }
      } else {
        await closeSidebar(page);
        return {
          result: {
            ...base,
            status: 'rejected',
            verified: false,
            reason: 'smart_pricing_enabled_or_unverified',
          },
          smartPricingOn: smartPricingState === true,
        };
      }
    }

    const input = page.locator(PRICE_INPUT_SELECTOR).first();
    const previousPrice = parsePrice(await input.inputValue({ timeout: 3_000 }).catch(() => ''));

    if (opts.dryRun) {
      await closeSidebar(page);
      return {
        result: {
          ...base,
          status: 'validated',
          verified: true,
          observed_price: previousPrice ?? undefined,
          previous_price: previousPrice ?? undefined,
        },
        smartPricingOn: false,
      };
    }

    if (previousPrice === opts.entry.price) {
      await closeSidebar(page);
      return {
        result: {
          ...base,
          status: 'already_set',
          verified: true,
          observed_price: opts.entry.price,
          previous_price: previousPrice,
        },
        smartPricingOn: false,
      };
    }

    const typed = await typePrice(input, opts.entry.price);
    if (!typed) {
      await closeSidebar(page);
      return {
        result: {
          ...base,
          status: 'failed',
          verified: false,
          previous_price: previousPrice ?? undefined,
          reason: 'worker_failed_or_missing_verification',
        },
        smartPricingOn: false,
      };
    }

    clickedSave = await clickEnabledSave(page);
    if (!clickedSave) {
      await closeSidebar(page);
      return {
        result: {
          ...base,
          status: 'failed',
          verified: false,
          previous_price: previousPrice ?? undefined,
          reason: 'worker_failed_or_missing_verification',
        },
        smartPricingOn: false,
      };
    }

    await page.waitForTimeout(2_000);
    const readback = await readBackSavedPrice(page, opts.entry.date, opts.clickDelayMs);
    if (!readback.closedBeforeReadback) {
      return {
        result: {
          ...base,
          status: 'ambiguous',
          verified: false,
          previous_price: previousPrice ?? undefined,
          reason: 'sidebar_close_failed',
        },
        smartPricingOn: false,
      };
    }
    if (readback.observedPrice === opts.entry.price) {
      await closeSidebar(page);
      return {
        result: {
          ...base,
          status: 'applied',
          verified: true,
          previous_price: previousPrice ?? undefined,
          observed_price: readback.observedPrice,
        },
        smartPricingOn: false,
      };
    }

    await closeSidebar(page);
    return {
      result: {
        ...base,
        status: 'ambiguous',
        verified: false,
        previous_price: previousPrice ?? undefined,
        observed_price: readback.observedPrice ?? undefined,
        reason: readback.observedPrice === null ? 'save_clicked_readback_failed' : 'value_mismatch_after_save',
      },
      smartPricingOn: false,
    };
  } catch (err) {
    if (err instanceof BrowserSetPricesError) {
      throw err;
    }
    await closeSidebar(page).catch(() => false);
    return {
      result: {
        ...base,
        status: clickedSave ? 'ambiguous' : 'failed',
        verified: false,
        reason: clickedSave ? 'save_clicked_readback_failed' : 'worker_failed_or_missing_verification',
      },
      smartPricingOn: false,
    };
  }
}

function normalizeBrowserSetPricesRequest(request: BrowserSetPricesRequest): BrowserSetPricesRequest {
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
      await page.evaluate((selector) => {
        const node = document.querySelector(selector);
        if (node instanceof HTMLElement) {
          node.scrollIntoView({ block: 'center' });
          node.click();
        }
      }, await cell.evaluate((node) => (node as HTMLElement).getAttribute('data-date')).then((date) => `[data-date="${date}"]`));
      return true;
    } catch {
      return false;
    }
  }
}

async function openPriceEditor(page: Page): Promise<boolean> {
  const priceSection = page.locator(`${SIDEBAR_SELECTOR} ${PRICE_SECTION_SELECTOR}`).first();
  const visible = await priceSection.isVisible({ timeout: 6_000 }).catch(() => false);
  if (!visible) return false;
  await priceSection.click({ timeout: 5_000 }).catch(() => undefined);
  const input = page.locator(PRICE_INPUT_SELECTOR).first();
  return input.isVisible({ timeout: 6_000 }).catch(() => false);
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

async function readSmartPricingEnabled(page: Page): Promise<boolean | null> {
  const sidebar = page.locator(SIDEBAR_SELECTOR).first();
  if (!(await sidebar.count().catch(() => 0))) return null;
  const sw = sidebar.locator('button[role="switch"]').first();
  if (!(await sw.count().catch(() => 0))) return null;
  const checked = await sw.getAttribute('aria-checked').catch(() => null);
  if (checked === 'true') return true;
  if (checked === 'false') return false;
  return null;
}

async function turnOffSmartPricing(page: Page): Promise<boolean> {
  const sidebar = page.locator(SIDEBAR_SELECTOR).first();
  const sw = sidebar.locator('button[role="switch"]').first();
  if (!(await sw.count().catch(() => 0))) return false;
  await sw.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  return (await readSmartPricingEnabled(page)) === false;
}

async function typePrice(input: Locator, price: number): Promise<boolean> {
  const priceText = String(price);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await input.click({ clickCount: 3, timeout: 5_000 });
      await input.fill(priceText, { timeout: 5_000 });
      if (parsePrice(await input.inputValue({ timeout: 2_000 }).catch(() => '')) === price) {
        return true;
      }
    } catch {
      // Retry once below.
    }
  }
  return false;
}

async function clickEnabledSave(page: Page): Promise<boolean> {
  const save = page.locator(SAVE_BUTTON_SELECTOR).first();
  for (let attempt = 0; attempt < 5; attempt++) {
    const visible = await save.isVisible({ timeout: 2_000 }).catch(() => false);
    const enabled = visible && await save.isEnabled({ timeout: 1_000 }).catch(() => false);
    if (enabled) {
      await save.click({ timeout: 5_000 });
      return true;
    }
    await page.waitForTimeout(700);
  }
  return false;
}

async function readBackSavedPrice(
  page: Page,
  date: string,
  clickDelayMs: number,
): Promise<{ closedBeforeReadback: boolean; observedPrice: number | null }> {
  const closed = await closeSidebar(page);
  if (!closed) {
    return { closedBeforeReadback: false, observedPrice: null };
  }
  const cell = await findDateCell(page, date);
  if (!cell) {
    return { closedBeforeReadback: true, observedPrice: null };
  }
  const cellTextBeforeClick = normalizeWhitespace(await cell.innerText({ timeout: 3_000 }).catch(() => ''));
  if (!await clickDateCell(page, cell)) {
    return { closedBeforeReadback: true, observedPrice: null };
  }
  await page.waitForTimeout(clickDelayMs);
  const sidebarText = normalizeWhitespace(await readSidebarText(page));
  return {
    closedBeforeReadback: true,
    observedPrice: chooseBestPrice(cellTextBeforeClick, sidebarText),
  };
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
    throw new BrowserSetPricesError('invalid_cookies');
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
  throw new BrowserSetPricesError('listing_mismatch');
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

function parsePrice(text: string): number | null {
  const normalized = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const currencyCodes = 'USD|CAD|EUR|GBP|AUD|NZD|MXN|BRL|JPY|CNY|HKD|SGD|CHF|SEK|NOK|DKK|PLN|CZK|ILS|KRW|THB|MYR|PHP|IDR|INR|ZAR|AED|SAR|TRY';
  const currencyPrefix = new RegExp(`(?:[$€£¥]|[A-Z]{1,3}\\$|${currencyCodes})\\s*$`);
  const currencySuffix = new RegExp(`^\\s*(?:[$€£¥]|${currencyCodes})\\s*$`);
  const commaDecimalPattern = new RegExp(
    `(?:[$€£¥]|[A-Z]{1,3}\\$|${currencyCodes})\\s*\\d+,\\d{2}|\\d+,\\d{2}\\s*(?:[$€£¥]|${currencyCodes})`,
  );
  if (commaDecimalPattern.test(normalized)) {
    return null;
  }

  const candidates: number[] = [];
  for (const match of normalized.matchAll(/[0-9]+(?:\.[0-9]{2})?/g)) {
    const raw = match[0];
    const index = match.index ?? -1;
    if (index < 0) continue;
    const before = normalized.slice(Math.max(0, index - 12), index);
    const after = normalized.slice(index + raw.length, index + raw.length + 12);
    const wholeBareNumber = normalized.trim() === raw;
    const valueHasCurrency = currencyPrefix.test(before) || currencySuffix.test(after);
    if (!wholeBareNumber && !valueHasCurrency) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) {
      candidates.push(Math.round(value));
    }
  }

  return candidates.length ? Math.max(...candidates) : null;
}

function chooseBestPrice(cellText: string, sidebarText: string): number | null {
  return parsePrice(cellText) ?? parsePrice(sidebarText);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export const __setPricesBrowserTestHooks = {
  chooseBestPrice,
  classifyDateState,
  normalizeBrowserSetPricesRequest,
  parsePrice,
};
