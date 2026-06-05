import type { BrowserContext, Page } from 'playwright';
import { openPage } from './browser';

export interface MarketScrapeConfig {
  location: string;
  currency: string;
  timezone?: string;
  adults: number;
  bedroom_counts: number[];
  night_counts: number[];
  horizon_days: number;
  target_dates?: string[];
  exclude_listing_ids: string[];
  hotel_names: string[];
  hotel_tax_multiplier: number;
  min_price: number;
  max_price: number;
}

export interface MarketListingRecord {
  roomId: string;
  name?: string;
  propertyType?: string;
  bedrooms: number;
  price1Night?: number;
  price2NightTotal?: number;
  price2NightPerNight?: number;
  minStay: number;
  rating?: number | null;
  reviewCount?: number | null;
  source: 'airbnb';
}

export interface MarketHotelRecord {
  name: string;
  listPrice: number;
  priceWithTax: number;
  source: 'booking';
}

export interface MarketScrapeDateRecord {
  date: string;
  dayOfWeek: number;
  dayName: string;
  isWeekend: boolean;
  listings: MarketListingRecord[];
  hotels: MarketHotelRecord[];
}

export interface ScrapeMarketPricesResult {
  success: boolean;
  schema_version: 1;
  scrapedAt: string;
  daysScraped: number;
  completedDays: number;
  dates: MarketScrapeDateRecord[];
  diagnostics: {
    dates_requested: number;
    dates_scraped: number;
    searches_attempted: number;
    searches_failed: number;
    blocked: boolean;
    failed_searches: Array<{ date: string; source: 'airbnb' | 'booking'; reason: string }>;
  };
}

interface DateInfo {
  checkIn: string;
  checkOutByNightCount: Record<number, string>;
  dayOfWeek: number;
  dayName: string;
  isWeekend: boolean;
}

interface RawSearchListing {
  roomId: string;
  name?: string;
  propertyType?: string;
  bedrooms?: number;
  totalPrice: number;
  nightCount: number;
  rating?: number | null;
  reviewCount?: number | null;
}

export class MarketScrapeError extends Error {
  constructor(public readonly code: 'no_dates_scraped' | 'blocked_by_airbnb', message = code) {
    super(message);
    this.name = 'MarketScrapeError';
  }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_WAIT_AFTER_LOAD_MS = 2_500;
const DEFAULT_INTER_SEARCH_DELAY_MS = 1_000;
const MAX_SCROLLS = 5;
const MAX_HORIZON_DAYS = 42;
const MAX_TARGET_DATES = 120;
const MARKET_MONEY_PATTERN_SOURCE = String.raw`(?:[$€£¥]\s*\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*(?:\.\d{2})?\s*(?:USD|CAD|EUR|GBP|AUD|NZD|MXN)\b)`;
const WEEKEND_DAYS = [5, 6];

export function normalizeMarketConfig(input: unknown): MarketScrapeConfig {
  if (!input || typeof input !== 'object') throw new Error('missing_market_config');
  const raw = input as Partial<MarketScrapeConfig>;
  const location = typeof raw.location === 'string' ? raw.location.trim() : '';
  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : 'USD';
  const timezone = normalizeTimezone(raw.timezone);
  const adults = Number.isInteger(raw.adults) ? Number(raw.adults) : 2;
  const bedroomCounts = normalizeNumberList(raw.bedroom_counts, [1, 2], { min: 0, max: 10, maxLength: 4 });
  const nightCounts = normalizeNumberList(raw.night_counts, [1, 2], { min: 1, max: 2, maxLength: 2 });
  const targetDates = normalizeTargetDates(raw.target_dates);
  const horizonDays = targetDates.length > 0
    ? targetDates.length
    : Number.isInteger(raw.horizon_days) ? Number(raw.horizon_days) : 42;
  const excludeListingIds = normalizeListingIds(raw.exclude_listing_ids);
  const hotelNames = normalizeStringList(raw.hotel_names, 30);
  const hotelTaxMultiplier = typeof raw.hotel_tax_multiplier === 'number' ? raw.hotel_tax_multiplier : 1;
  const minPrice = Number.isInteger(raw.min_price) ? Number(raw.min_price) : 50;
  const maxPrice = Number.isInteger(raw.max_price) ? Number(raw.max_price) : 999;

  if (location.length < 2) throw new Error('invalid_market_location');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('invalid_currency');
  if (adults < 1 || adults > 16) throw new Error('invalid_adults');
  if (targetDates.length === 0 && (horizonDays < 1 || horizonDays > MAX_HORIZON_DAYS)) throw new Error('invalid_horizon_days');
  if (targetDates.length > MAX_TARGET_DATES) throw new Error('invalid_target_dates');
  if (hotelTaxMultiplier <= 0 || hotelTaxMultiplier > 2) throw new Error('invalid_hotel_tax_multiplier');
  if (minPrice < 1 || maxPrice < minPrice || maxPrice > 100_000) throw new Error('invalid_price_bounds');

  return {
    location,
    currency,
    ...(timezone ? { timezone } : {}),
    adults,
    bedroom_counts: bedroomCounts,
    night_counts: nightCounts,
    horizon_days: horizonDays,
    ...(targetDates.length > 0 ? { target_dates: targetDates } : {}),
    exclude_listing_ids: excludeListingIds,
    hotel_names: hotelNames,
    hotel_tax_multiplier: hotelTaxMultiplier,
    min_price: minPrice,
    max_price: maxPrice,
  };
}

export function generateMarketDates(horizonDays: number, maxNightCount: number, timeZone = 'UTC'): DateInfo[] {
  const dates: DateInfo[] = [];
  let checkIn = addDaysISO(localDateISO(new Date(), timeZone), 1);

  for (let i = 0; i < horizonDays; i++) {
    dates.push(dateInfoFor(checkIn, maxNightCount));
    checkIn = addDaysISO(checkIn, 1);
  }

  return dates;
}

export function generateMarketDatesFromTargets(targetDates: string[], maxNightCount: number): DateInfo[] {
  return targetDates.map((checkIn) => dateInfoFor(checkIn, maxNightCount));
}

function dateInfoFor(checkIn: string, maxNightCount: number): DateInfo {
  const parsed = parseISODate(checkIn);
  if (!parsed) throw new Error('invalid_target_dates');
  const checkInDate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12));
  const checkOutByNightCount: Record<number, string> = {};
  for (let nights = 1; nights <= maxNightCount; nights++) {
    const checkOut = new Date(checkInDate);
    checkOut.setUTCDate(checkInDate.getUTCDate() + nights);
    checkOutByNightCount[nights] = isoDate(checkOut);
  }
  const dayOfWeek = checkInDate.getUTCDay();
  return {
    checkIn,
    checkOutByNightCount,
    dayOfWeek,
    dayName: DAY_NAMES[dayOfWeek],
    isWeekend: WEEKEND_DAYS.includes(dayOfWeek),
  };
}

export function buildAirbnbSearchUrl(opts: {
  location: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  bedrooms: number;
  currency: string;
}): string {
  const params = new URLSearchParams({
    checkin: opts.checkIn,
    checkout: opts.checkOut,
    adults: String(opts.adults),
    min_bedrooms: String(opts.bedrooms),
    max_bedrooms: String(opts.bedrooms),
    currency: opts.currency,
  });
  return `https://www.airbnb.com/s/${encodeAirbnbLocation(opts.location)}/homes?${params.toString()}`;
}

export function buildBookingSearchUrl(opts: {
  location: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  currency: string;
}): string {
  const params = new URLSearchParams({
    ss: opts.location,
    checkin: opts.checkIn,
    checkout: opts.checkOut,
    group_adults: String(opts.adults),
    selected_currency: opts.currency,
  });
  return `https://www.booking.com/searchresults.html?${params.toString()}`;
}

export async function scrapeMarketPrices(
  ctx: BrowserContext,
  opts: {
    market: MarketScrapeConfig;
    waitAfterLoadMs?: number;
    interSearchDelayMs?: number;
  },
): Promise<ScrapeMarketPricesResult> {
  const market = normalizeMarketConfig(opts.market);
  const maxNightCount = Math.max(...market.night_counts);
  const dateInfos = market.target_dates?.length
    ? generateMarketDatesFromTargets(market.target_dates, maxNightCount)
    : generateMarketDates(market.horizon_days, maxNightCount, market.timezone ?? 'UTC');
  const dates: MarketScrapeDateRecord[] = [];
  const failedSearches: ScrapeMarketPricesResult['diagnostics']['failed_searches'] = [];
  let searchesAttempted = 0;
  let searchesFailed = 0;
  let blocked = false;

  const page = await openPage(ctx);
  try {
    for (const dateInfo of dateInfos) {
      const rawByBedroomNight = new Map<string, RawSearchListing[]>();

      for (const bedrooms of market.bedroom_counts) {
        for (const nights of market.night_counts) {
          searchesAttempted++;
          try {
            const listings = await scrapeAirbnbSearch(page, market, dateInfo, bedrooms, nights, {
              waitAfterLoadMs: opts.waitAfterLoadMs ?? DEFAULT_WAIT_AFTER_LOAD_MS,
            });
            rawByBedroomNight.set(searchKey(bedrooms, nights), listings);
          } catch (err) {
            searchesFailed++;
            const reason = reasonFromError(err);
            if (reason === 'blocked_by_airbnb') blocked = true;
            failedSearches.push({ date: dateInfo.checkIn, source: 'airbnb', reason });
          }
          if (blocked) break;
          await sleep(opts.interSearchDelayMs ?? DEFAULT_INTER_SEARCH_DELAY_MS);
        }
        if (blocked) break;
      }

      let hotels: MarketHotelRecord[] = [];
      if (!blocked && market.hotel_names.length > 0) {
        searchesAttempted++;
        try {
          hotels = await scrapeBookingHotels(page, market, dateInfo, {
            waitAfterLoadMs: opts.waitAfterLoadMs ?? DEFAULT_WAIT_AFTER_LOAD_MS,
          });
        } catch (err) {
          searchesFailed++;
          failedSearches.push({ date: dateInfo.checkIn, source: 'booking', reason: reasonFromError(err) });
        }
      }

      const dayData = processDateResults(dateInfo, market, rawByBedroomNight, hotels);
      dates.push(dayData);
      if (blocked) break;
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  if (dates.length === 0) {
    throw new MarketScrapeError(blocked ? 'blocked_by_airbnb' : 'no_dates_scraped');
  }

  return {
    success: !blocked,
    schema_version: 1,
    scrapedAt: new Date().toISOString(),
    daysScraped: dateInfos.length,
    completedDays: dates.length,
    dates,
    diagnostics: {
      dates_requested: dateInfos.length,
      dates_scraped: dates.length,
      searches_attempted: searchesAttempted,
      searches_failed: searchesFailed,
      blocked,
      failed_searches: failedSearches,
    },
  };
}

async function scrapeAirbnbSearch(
  page: Page,
  market: MarketScrapeConfig,
  dateInfo: DateInfo,
  bedrooms: number,
  nights: number,
  opts: { waitAfterLoadMs: number },
): Promise<RawSearchListing[]> {
  const url = buildAirbnbSearchUrl({
    location: market.location,
    checkIn: dateInfo.checkIn,
    checkOut: dateInfo.checkOutByNightCount[nights],
    adults: market.adults,
    bedrooms,
    currency: market.currency,
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(opts.waitAfterLoadMs);

  if (await isBlockedPage(page)) {
    throw new MarketScrapeError('blocked_by_airbnb');
  }

  return extractListingsFromPage(page, {
    bedrooms,
    nights,
    excludeListingIds: market.exclude_listing_ids,
  });
}

async function scrapeBookingHotels(
  page: Page,
  market: MarketScrapeConfig,
  dateInfo: DateInfo,
  opts: { waitAfterLoadMs: number },
): Promise<MarketHotelRecord[]> {
  const url = buildBookingSearchUrl({
    location: market.location,
    checkIn: dateInfo.checkIn,
    checkOut: dateInfo.checkOutByNightCount[1],
    adults: market.adults,
    currency: market.currency,
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(opts.waitAfterLoadMs);
  await scrollPage(page, 3);

  const rawHotels = await page.evaluate(({ targetHotels, moneyPatternSource }: {
    targetHotels: string[];
    moneyPatternSource: string;
  }) => {
    const results: Array<{ name: string; listPrice: number }> = [];
    const parseMoney = (text: string): number | null => {
      const match = text.match(new RegExp(moneyPatternSource, 'i'));
      const amount = match?.[0]?.match(/\d[\d,]*(?:\.\d{2})?/)?.[0];
      if (!amount) return null;
      const parsed = Number(amount.replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const cards = Array.from(document.querySelectorAll('[data-testid="property-card"]'));
    for (const card of cards) {
      const text = (card as HTMLElement).innerText ?? '';
      const target = targetHotels.find((hotel) => text.toLowerCase().includes(hotel.toLowerCase()));
      if (!target) continue;
      const nameMatch = text.match(/^([^\n]+)/);
      const listPrice = parseMoney(text);
      if (nameMatch && listPrice !== null) {
        results.push({
          name: nameMatch[1].trim(),
          listPrice,
        });
      }
    }
    return results;
  }, { targetHotels: market.hotel_names, moneyPatternSource: MARKET_MONEY_PATTERN_SOURCE });

  return rawHotels
    .filter((hotel) => hotel.listPrice >= market.min_price && hotel.listPrice <= market.max_price)
    .map((hotel) => ({
      name: hotel.name,
      listPrice: hotel.listPrice,
      priceWithTax: Math.round(hotel.listPrice * market.hotel_tax_multiplier),
      source: 'booking' as const,
    }));
}

async function extractListingsFromPage(
  page: Page,
  opts: { bedrooms: number; nights: number; excludeListingIds: string[] },
): Promise<RawSearchListing[]> {
  await scrollPage(page, MAX_SCROLLS);
  const listings = await page.evaluate((moneyPatternSource: string) => {
    const results: RawSearchListing[] = [];
    const seen = new Set<string>();
    const cards = Array.from(document.querySelectorAll('[itemprop="itemListElement"]'));

    for (const card of cards) {
      const text = (card as HTMLElement).innerText ?? '';
      const link = card.querySelector('a[href*="/rooms/"]') as HTMLAnchorElement | null;
      const roomMatch = link?.href.match(/\/rooms\/(\d+)/);
      if (!roomMatch) continue;
      const roomId = roomMatch[1];
      if (seen.has(roomId)) continue;
      seen.add(roomId);

      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      let name = '';
      let propertyType = '';
      let bedrooms = 0;
      let totalPrice: number | null = null;
      let nightlyPrice: number | null = null;
      let nightCount = 1;
      let rating: number | null = null;
      let reviewCount: number | null = null;
      const parseMoney = (value: string): number | null => {
        const match = value.match(new RegExp(moneyPatternSource, 'i'));
        const amount = match?.[0]?.match(/\d[\d,]*(?:\.\d{2})?/)?.[0];
        if (!amount) return null;
        const parsed = Number(amount.replace(/,/g, ''));
        return Number.isFinite(parsed) ? parsed : null;
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const typeMatch = line.match(/^(Home|Room|Condo|Apartment|Cabin|Cottage|Tiny homes?|Treehouse|Loft|Guest suite|Guesthouse|Villa|Townhouse|Chalet|Farm stay|Tent|Place to stay|Rooms)\s+in\s+(.+)/i);
        if (typeMatch) {
          propertyType = typeMatch[1];
          const nextLine = lines[i + 1] ?? '';
          if (nextLine && !/bedroom|studio|\d+ bed/i.test(nextLine)) name = nextLine;
        }

        const brMatch = line.match(/^(\d+)\s+bedroom/i);
        if (brMatch) bedrooms = Number(brMatch[1]);
        if (line.toLowerCase() === 'studio') bedrooms = 0;

        const nightMatch = line.match(/for\s+(\d+)\s+night/i);
        if (nightMatch) nightCount = Number(nightMatch[1]);

        const money = parseMoney(line);
        if (money !== null) {
          const explicitNightMatch = line.match(/for\s+(\d+)\s+night/i);
          if (explicitNightMatch) {
            totalPrice = money;
            nightCount = Number(explicitNightMatch[1]);
          } else if (/total|before taxes|taxes included/i.test(line)) {
            totalPrice = money;
          } else if (/night|per night/i.test(line) && nightlyPrice === null) {
            nightlyPrice = money;
          }
        }

        const ratingMatch = line.match(/([\d.]+)\s+out of 5.*?(\d+)\s+review/);
        if (ratingMatch) {
          rating = Number(ratingMatch[1]);
          reviewCount = Number(ratingMatch[2]);
        }
        const ratingMatch2 = line.match(/^([\d.]+)\s+\((\d+)\)$/);
        if (ratingMatch2) {
          rating = Number(ratingMatch2[1]);
          reviewCount = Number(ratingMatch2[2]);
        }
      }

      if (totalPrice === null && nightlyPrice !== null) {
        totalPrice = nightlyPrice * nightCount;
      }

      if (totalPrice !== null) {
        results.push({ roomId, name, propertyType, bedrooms, totalPrice, nightCount, rating, reviewCount });
      }
    }

    return results;
  }, MARKET_MONEY_PATTERN_SOURCE);

  return listings
    .filter((listing) => !opts.excludeListingIds.includes(listing.roomId))
    .map((listing) => ({ ...listing, bedrooms: listing.bedrooms || opts.bedrooms, nightCount: opts.nights }));
}

function processDateResults(
  dateInfo: DateInfo,
  market: MarketScrapeConfig,
  rawByBedroomNight: Map<string, RawSearchListing[]>,
  hotels: MarketHotelRecord[],
): MarketScrapeDateRecord {
  const listingsByRoom = new Map<string, MarketListingRecord>();
  const oneNightRoomsByBedroom = new Map<number, Set<string>>();

  for (const bedrooms of market.bedroom_counts) {
    const oneNight = rawByBedroomNight.get(searchKey(bedrooms, 1)) ?? [];
    oneNightRoomsByBedroom.set(bedrooms, new Set(oneNight.map((listing) => listing.roomId)));
    for (const listing of oneNight) {
      if (!withinPriceBounds(listing.totalPrice, market)) continue;
      listingsByRoom.set(listing.roomId, {
        roomId: listing.roomId,
        name: listing.name,
        propertyType: listing.propertyType,
        bedrooms: listing.bedrooms || bedrooms,
        price1Night: listing.totalPrice,
        minStay: 1,
        rating: listing.rating,
        reviewCount: listing.reviewCount,
        source: 'airbnb',
      });
    }
  }

  for (const bedrooms of market.bedroom_counts) {
    for (const nights of market.night_counts.filter((value) => value > 1)) {
      const listings = rawByBedroomNight.get(searchKey(bedrooms, nights)) ?? [];
      const oneNightRooms = oneNightRoomsByBedroom.get(bedrooms) ?? new Set<string>();
      for (const listing of listings) {
        const perNight = Math.round(listing.totalPrice / nights);
        if (!withinPriceBounds(perNight, market)) continue;
        const existing = listingsByRoom.get(listing.roomId);
        if (existing) {
          existing.price2NightTotal = listing.totalPrice;
          existing.price2NightPerNight = perNight;
        } else if (!oneNightRooms.has(listing.roomId)) {
          listingsByRoom.set(listing.roomId, {
            roomId: listing.roomId,
            name: listing.name,
            propertyType: listing.propertyType,
            bedrooms: listing.bedrooms || bedrooms,
            price2NightTotal: listing.totalPrice,
            price2NightPerNight: perNight,
            minStay: nights,
            rating: listing.rating,
            reviewCount: listing.reviewCount,
            source: 'airbnb',
          });
        }
      }
    }
  }

  return {
    date: dateInfo.checkIn,
    dayOfWeek: dateInfo.dayOfWeek,
    dayName: dateInfo.dayName,
    isWeekend: dateInfo.isWeekend,
    listings: Array.from(listingsByRoom.values()),
    hotels,
  };
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

async function scrollPage(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => undefined);
    await page.waitForTimeout(400);
  }
}

function normalizeNumberList(
  value: unknown,
  fallback: number[],
  opts: { min: number; max: number; maxLength: number },
): number[] {
  const source = Array.isArray(value) ? value : fallback;
  const out: number[] = [];
  for (const raw of source) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < opts.min || n > opts.max) throw new Error('invalid_number_list');
    if (!out.includes(n)) out.push(n);
  }
  if (out.length === 0 || out.length > opts.maxLength) throw new Error('invalid_number_list');
  return out;
}

function normalizeStringList(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) continue;
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > maxLength) throw new Error('too_many_items');
  return out;
}

function normalizeTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    throw new Error('invalid_timezone');
  }
}

function normalizeTargetDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const raw of value) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) throw new Error('invalid_target_dates');
    if (!parseISODate(text)) throw new Error('invalid_target_dates');
    out.add(text);
    if (out.size > MAX_TARGET_DATES) throw new Error('invalid_target_dates');
  }
  return Array.from(out).sort();
}

function normalizeListingIds(value: unknown): string[] {
  const ids = normalizeStringList(value, 100);
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error('invalid_listing_id');
  }
  return ids;
}

function encodeAirbnbLocation(location: string): string {
  return location
    .trim()
    .replace(/,/g, '')
    .split(/\s+/)
    .map((part) => encodeURIComponent(part))
    .join('--');
}

function isoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function isoDateFromUTCParts(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, 12)).toISOString().split('T')[0];
}

function addDaysISO(date: string, days: number): string {
  const parsed = parseISODate(date);
  if (!parsed) throw new Error('invalid_target_dates');
  return isoDateFromUTCParts(parsed.year, parsed.month, parsed.day + days);
}

function localDateISO(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('invalid_timezone');
  return `${year}-${month}-${day}`;
}

function parseISODate(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function searchKey(bedrooms: number, nights: number): string {
  return `${bedrooms}br:${nights}n`;
}

function withinPriceBounds(value: number, market: MarketScrapeConfig): boolean {
  return value >= market.min_price && value <= market.max_price;
}

function parseMarketMoneyText(text: string): number | null {
  const match = text.match(new RegExp(MARKET_MONEY_PATTERN_SOURCE, 'i'));
  const amount = match?.[0]?.match(/\d[\d,]*(?:\.\d{2})?/)?.[0];
  if (!amount) return null;
  const parsed = Number(amount.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function reasonFromError(err: unknown): string {
  if (err instanceof MarketScrapeError) return err.code;
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __marketScraperTestHooks = {
  normalizeMarketConfig,
  generateMarketDates,
  generateMarketDatesFromTargets,
  buildAirbnbSearchUrl,
  buildBookingSearchUrl,
  processDateResults,
  parseMarketMoneyText,
};
