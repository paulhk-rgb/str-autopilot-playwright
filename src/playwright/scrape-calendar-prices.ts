import type { BrowserContext, Page } from 'playwright';
import { openPage } from './browser';

export interface CalendarPriceScrapeRequest {
  listing_id: string;
  start_date: string;
  end_date: string;
  currency?: string;
}

export interface CalendarPriceRecord {
  date: string;
  price: number | null;
  min_stay: number | null;
  is_booked: boolean;
  is_blocked: boolean;
  currency: string | null;
  diagnostics?: {
    cell_text?: string;
    sidebar_seen?: boolean;
    click_failed?: boolean;
  };
}

export interface ScrapeCalendarPricesResult {
  success: boolean;
  schema_version: 1;
  listing_id: string;
  start_date: string;
  end_date: string;
  scraped_at: string;
  smart_pricing_enabled: boolean | null;
  prices: CalendarPriceRecord[];
  diagnostics: {
    dates_requested: number;
    dates_scraped: number;
    missing_dates: string[];
    blocked: boolean;
  };
}

export class CalendarPriceScrapeError extends Error {
  constructor(
    public readonly code: 'blocked_by_airbnb' | 'invalid_cookies' | 'listing_mismatch' | 'no_dates_found',
    message = code,
  ) {
    super(message);
    this.name = 'CalendarPriceScrapeError';
  }
}

const MAX_CALENDAR_DAYS = 90;
const CALENDAR_READY_TIMEOUT_MS = 20_000;
const CALENDAR_URL_PREFIX = 'https://www.airbnb.com/multicalendar/';

export function normalizeCalendarPriceRequest(input: unknown): Required<CalendarPriceScrapeRequest> {
  if (!input || typeof input !== 'object') throw new Error('missing_calendar_price_request');
  const raw = input as Partial<CalendarPriceScrapeRequest>;
  const listingId = typeof raw.listing_id === 'string' ? raw.listing_id.trim() : '';
  const startDate = typeof raw.start_date === 'string' ? raw.start_date.trim() : '';
  const endDate = typeof raw.end_date === 'string' ? raw.end_date.trim() : '';
  const currency = typeof raw.currency === 'string' && raw.currency.trim()
    ? raw.currency.trim().toUpperCase()
    : 'USD';

  if (!/^\d+$/.test(listingId)) throw new Error('invalid_listing_id');
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) throw new Error('invalid_date');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('invalid_currency');

  const dates = dateRange(startDate, endDate);
  if (dates.length === 0) throw new Error('invalid_date_range');
  if (dates.length > MAX_CALENDAR_DAYS) throw new Error('date_range_too_large');

  return {
    listing_id: listingId,
    start_date: startDate,
    end_date: endDate,
    currency,
  };
}

export function buildMulticalendarUrl(listingId: string): string {
  return `${CALENDAR_URL_PREFIX}${encodeURIComponent(listingId)}`;
}

export async function scrapeCalendarPrices(
  ctx: BrowserContext,
  opts: {
    request: CalendarPriceScrapeRequest;
    waitAfterLoadMs?: number;
    clickDelayMs?: number;
  },
): Promise<ScrapeCalendarPricesResult> {
  const request = normalizeCalendarPriceRequest(opts.request);
  const dates = dateRange(request.start_date, request.end_date);
  const page = await openPage(ctx);
  const prices: CalendarPriceRecord[] = [];
  const missingDates: string[] = [];
  let smartPricingEnabled: boolean | null = null;
  let blocked = false;

  try {
    await gotoWithRetry(page, buildMulticalendarUrl(request.listing_id));
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(opts.waitAfterLoadMs ?? 2_000);

    if (isLoginUrl(page.url())) {
      throw new CalendarPriceScrapeError('invalid_cookies');
    }
    if (await isBlockedPage(page)) {
      throw new CalendarPriceScrapeError('blocked_by_airbnb');
    }

    await waitForCalendarReady(page);
    await assertCalendarPageStillSafe(page, request.listing_id);

    for (const date of dates) {
      await assertCalendarPageStillSafe(page, request.listing_id);
      const record = await collectDateRecord(page, {
        date,
        currency: request.currency,
        clickDelayMs: opts.clickDelayMs ?? 600,
        listingId: request.listing_id,
      });

      if (!record) {
        missingDates.push(date);
        continue;
      }
      prices.push(record);
      if (smartPricingEnabled === null) {
        smartPricingEnabled = await readSmartPricingEnabled(page);
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  if (blocked) {
    throw new CalendarPriceScrapeError('blocked_by_airbnb');
  }
  if (prices.length === 0) {
    throw new CalendarPriceScrapeError('no_dates_found');
  }

  return {
    success: true,
    schema_version: 1,
    listing_id: request.listing_id,
    start_date: request.start_date,
    end_date: request.end_date,
    scraped_at: new Date().toISOString(),
    smart_pricing_enabled: smartPricingEnabled,
    prices,
    diagnostics: {
      dates_requested: dates.length,
      dates_scraped: prices.length,
      missing_dates: missingDates,
      blocked,
    },
  };
}

async function collectDateRecord(
  page: Page,
  opts: { date: string; currency: string; clickDelayMs: number; listingId: string },
): Promise<CalendarPriceRecord | null> {
  const cell = await findDateCell(page, opts.date);
  if (!cell) return null;

  const cellText = normalizeWhitespace(await cell.innerText({ timeout: 3_000 }).catch(() => ''));
  await cell.scrollIntoViewIfNeeded().catch(() => undefined);
  try {
    await cell.click({ timeout: 5_000 });
  } catch {
    return {
      date: opts.date,
      price: null,
      min_stay: null,
      is_booked: false,
      is_blocked: true,
      currency: opts.currency,
      diagnostics: {
        cell_text: cellText || undefined,
        sidebar_seen: false,
        click_failed: true,
      },
    };
  }
  await page.waitForTimeout(opts.clickDelayMs);
  await assertCalendarPageStillSafe(page, opts.listingId);

  const sidebarText = normalizeWhitespace(await readSidebarText(page));
  const combinedText = normalizeWhitespace(`${cellText} ${sidebarText}`);
  const isBooked = isBookedDateText(combinedText);
  const isBlocked = isBlockedDateText(combinedText);
  const price = isBooked || isBlocked ? null : chooseCalendarPrice(cellText, sidebarText);
  const minStay = parseMinStay(sidebarText);

  return {
    date: opts.date,
    price,
    min_stay: minStay,
    is_booked: isBooked,
    is_blocked: isBlocked,
    currency: opts.currency,
    diagnostics: {
      cell_text: cellText || undefined,
      sidebar_seen: sidebarText.length > 0,
    },
  };
}

async function findDateCell(page: Page, date: string) {
  const selector = `[data-date="${date}"]`;
  for (let i = 0; i < 6; i++) {
    const cell = page.locator(selector).first();
    if (await cell.count().catch(() => 0)) {
      return cell;
    }
    await page.evaluate(() => window.scrollBy(0, 800)).catch(() => undefined);
    await page.waitForTimeout(i === 0 ? 1_000 : 400);
  }
  return null;
}

async function readSidebarText(page: Page): Promise<string> {
  const sidebar = page.locator('#HOST-CALENDAR-SIDEBAR-CONTAINER').first();
  if (!(await sidebar.count().catch(() => 0))) return '';
  return sidebar.innerText({ timeout: 3_000 }).catch(() => '');
}

async function readSmartPricingEnabled(page: Page): Promise<boolean | null> {
  const sidebar = page.locator('#HOST-CALENDAR-SIDEBAR-CONTAINER').first();
  if (!(await sidebar.count().catch(() => 0))) return null;
  const sw = sidebar.locator('button[role="switch"]').first();
  if (!(await sw.count().catch(() => 0))) return null;
  const checked = await sw.getAttribute('aria-checked').catch(() => null);
  if (checked === 'true') return true;
  if (checked === 'false') return false;
  return null;
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

async function assertCalendarPageStillSafe(page: Page, listingId: string): Promise<void> {
  if (isLoginUrl(page.url())) {
    throw new CalendarPriceScrapeError('invalid_cookies');
  }
  if (await isBlockedPage(page)) {
    throw new CalendarPriceScrapeError('blocked_by_airbnb');
  }
  assertCalendarUrlMatchesListing(page.url(), listingId);
}

function isLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('airbnb.com') && parsed.pathname.includes('/login');
  } catch {
    return false;
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
  throw new CalendarPriceScrapeError('listing_mismatch');
}

function parsePrice(text: string): number | null {
  const match = text.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function chooseCalendarPrice(cellText: string, sidebarText: string): number | null {
  return parsePrice(cellText) ?? parsePrice(sidebarText);
}

function parseMinStay(text: string): number | null {
  const patterns = [
    /(?:minimum|min(?:imum)? stay)[^\d]{0,20}(\d{1,3})\s*nights?/i,
    /(\d{1,3})\s*nights?[^\n]{0,30}(?:minimum|min(?:imum)? stay)/i,
    /(?:minimum|min(?:imum)?)[^\d]{0,20}(\d{1,3})\s*nights?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      return Number.isInteger(value) && value > 0 ? value : null;
    }
  }
  return null;
}

function isBookedDateText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('currently hosting') ||
    normalized.includes('arrives in') ||
    normalized.includes('checking out') ||
    normalized.includes('guest checked in') ||
    normalized.includes('confirmation code') ||
    /\bcheck-?in\b/.test(normalized) && /\bcheck-?out\b/.test(normalized) && /\bguest\b/.test(normalized);
}

function isBlockedDateText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('blocked') ||
    normalized.includes('not available') ||
    normalized.includes('unavailable');
}

function dateRange(startDate: string, endDate: string): string[] {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return [];
  const start = dateToUtc(startDate);
  const end = dateToUtc(endDate);
  if (end.getTime() < start.getTime()) return [];
  const dates: string[] = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addDays(cursor, 1)) {
    dates.push(formatIsoDate(cursor));
  }
  return dates;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return formatIsoDate(dateToUtc(value)) === value;
}

function dateToUtc(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export const __calendarPriceScraperTestHooks = {
  normalizeCalendarPriceRequest,
  dateRange,
  buildMulticalendarUrl,
  parsePrice,
  chooseCalendarPrice,
  assertCalendarPageStillSafe,
  assertCalendarUrlMatchesListing,
  parseMinStay,
  isBookedDateText,
  isBlockedDateText,
};
