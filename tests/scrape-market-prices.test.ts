import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/scrape-market-prices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright/scrape-market-prices')>();
  return {
    ...actual,
    scrapeMarketPrices: vi.fn(),
  };
});

import { scrapeMarketPricesHandler } from '../src/endpoints/scrape-market-prices';
import * as browserModule from '../src/playwright/browser';
import * as marketScraperModule from '../src/playwright/scrape-market-prices';
import {
  __marketScraperTestHooks,
  MarketScrapeError,
} from '../src/playwright/scrape-market-prices';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';
import { __resetSingleFlightForTesting } from '../src/lib/single-flight';

const HOST_ID = '11111111-2222-3333-4444-555555555555';

const env: MachineEnv = {
  HMAC_SECRET: '7b2e2f1a0d6c4e6e89ab22c3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d',
  HOST_ID,
  CALLBACK_URL: 'http://localhost:9999/callback',
  PORT: 8080,
  PROFILE_DIR: '/tmp/test-profile',
  INBOX_READER_MODE: 'ui',
  AIRBNB_API_USER_ID: null,
  AIRBNB_API_GLOBAL_USER_ID: null,
  AIRBNB_API_KEY: 'k',
  AIRBNB_API_INBOX_HASH: 'h1',
  AIRBNB_API_THREAD_HASH: 'h2',
  WATERMARKS_PATH: '/tmp/wm.json',
};

const validBody = {
  host_id: HOST_ID,
  property_id: 'property-1',
  market: {
    location: 'Portland, Maine',
    currency: 'USD',
    adults: 2,
    bedroom_counts: [1, 2],
    night_counts: [1, 2],
    horizon_days: 2,
    exclude_listing_ids: ['12345678'],
    hotel_names: ['Waterfront Hotel'],
    hotel_tax_multiplier: 1.18,
    min_price: 50,
    max_price: 999,
  },
};

function buildReqRes(body: unknown): {
  req: Request;
  res: Response;
  jsonSpy: ReturnType<typeof vi.fn>;
  statusSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn();
  const res = {
    status: vi.fn(),
    json: jsonSpy,
  } as unknown as Response & { status: ReturnType<typeof vi.fn> };
  res.status.mockImplementation(() => res);
  const req = { body } as Request;
  return { req, res, jsonSpy, statusSpy: res.status };
}

beforeEach(() => {
  __resetSingleFlightForTesting();
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.readAirbnbSessionStrict).mockReset();
  vi.mocked(marketScraperModule.scrapeMarketPrices).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
});

describe('market price scraper guards', () => {
  it('normalizes market config without Paul-specific defaults', () => {
    const config = __marketScraperTestHooks.normalizeMarketConfig({
      location: 'Portland, Maine',
      currency: 'usd',
      adults: 2,
      bedroom_counts: [1, 1, 2],
      night_counts: [1, 2],
      horizon_days: 42,
      exclude_listing_ids: ['12345678'],
      hotel_names: ['Waterfront Hotel'],
      hotel_tax_multiplier: 1.18,
    });

    expect(config).toMatchObject({
      location: 'Portland, Maine',
      currency: 'USD',
      bedroom_counts: [1, 2],
      night_counts: [1, 2],
      horizon_days: 42,
      exclude_listing_ids: ['12345678'],
    });
  });

  it('accepts explicit target dates for user-selected scrape plans', () => {
    const config = __marketScraperTestHooks.normalizeMarketConfig({
      location: 'Portland, Maine',
      horizon_days: 99,
      target_dates: ['2026-07-05', '2026-07-03', '2026-07-01', '2026-07-03'],
    });

    expect(config.horizon_days).toBe(3);
    expect(config.target_dates).toEqual(['2026-07-01', '2026-07-03', '2026-07-05']);

    const dateInfos = __marketScraperTestHooks.generateMarketDatesFromTargets(
      config.target_dates ?? [],
      2,
    );
    expect(dateInfos).toEqual([
      expect.objectContaining({
        checkIn: '2026-07-01',
        checkOutByNightCount: { 1: '2026-07-02', 2: '2026-07-03' },
        dayName: 'Wed',
        isWeekend: false,
      }),
      expect.objectContaining({
        checkIn: '2026-07-03',
        checkOutByNightCount: { 1: '2026-07-04', 2: '2026-07-05' },
        dayName: 'Fri',
        isWeekend: true,
      }),
      expect.objectContaining({
        checkIn: '2026-07-05',
        checkOutByNightCount: { 1: '2026-07-06', 2: '2026-07-07' },
        dayName: 'Sun',
        isWeekend: false,
      }),
    ]);
  });

  it('rejects malformed market config and over-large horizons', () => {
    expect(() => __marketScraperTestHooks.normalizeMarketConfig({ location: '' })).toThrow(
      'invalid_market_location',
    );
    expect(() => __marketScraperTestHooks.normalizeMarketConfig({
      location: 'Portland, Maine',
      horizon_days: 43,
    })).toThrow('invalid_horizon_days');
    expect(() => __marketScraperTestHooks.normalizeMarketConfig({
      location: 'Portland, Maine',
      exclude_listing_ids: ['not-a-number'],
    })).toThrow('invalid_listing_id');
    expect(() => __marketScraperTestHooks.normalizeMarketConfig({
      location: 'Portland, Maine',
      night_counts: [1, 2, 3],
    })).toThrow('invalid_number_list');
    expect(() => __marketScraperTestHooks.normalizeMarketConfig({
      location: 'Portland, Maine',
      target_dates: ['2026-02-31'],
    })).toThrow('invalid_target_dates');
  });

  it('builds search URLs from supplied market config', () => {
    expect(__marketScraperTestHooks.buildAirbnbSearchUrl({
      location: 'Portland, Maine',
      checkIn: '2026-06-01',
      checkOut: '2026-06-03',
      adults: 2,
      bedrooms: 2,
      currency: 'USD',
    })).toBe(
      'https://www.airbnb.com/s/Portland--Maine/homes?checkin=2026-06-01&checkout=2026-06-03&adults=2&min_bedrooms=2&max_bedrooms=2&currency=USD',
    );
  });

  it('parses supported market price text without treating ratings as prices', () => {
    expect(__marketScraperTestHooks.parseMarketMoneyText('$1,234 total')).toBe(1234);
    expect(__marketScraperTestHooks.parseMarketMoneyText('€215.50 per night')).toBe(215.5);
    expect(__marketScraperTestHooks.parseMarketMoneyText('215 USD total before taxes')).toBe(215);
    expect(__marketScraperTestHooks.parseMarketMoneyText('4.8 out of 5 · 32 reviews')).toBeNull();
  });

  it('does not contain legacy Paul-only market constants', () => {
    const source = readFileSync(join(__dirname, '../src/playwright/scrape-market-prices.ts'), 'utf8');
    expect(source).not.toContain('35702467');
    expect(source).not.toContain('1238734339606310870');
    expect(source).not.toContain('Hotel Ithaca');
    expect(source).not.toContain('ctc-airbnb-2026');
  });
});

describe('/scrape-market-prices endpoint', () => {
  it('rejects malformed bodies before opening the browser', async () => {
    const { req, res, statusSpy } = buildReqRes({
      ...validBody,
      market: { ...validBody.market, horizon_days: 99 },
    });

    await scrapeMarketPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
  });

  it('rejects host mismatches', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      ...validBody,
      host_id: 'other-host',
    });

    await scrapeMarketPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'host_id_mismatch' });
  });

  it('maps missing Airbnb session cookies to invalid_cookies', async () => {
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await scrapeMarketPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(marketScraperModule.scrapeMarketPrices).not.toHaveBeenCalled();
  });

  it('returns configured market scrape results', async () => {
    vi.mocked(marketScraperModule.scrapeMarketPrices).mockResolvedValueOnce({
      success: true,
      schema_version: 1,
      scrapedAt: '2026-06-01T00:00:00.000Z',
      daysScraped: 2,
      completedDays: 2,
      dates: [],
      diagnostics: {
        dates_requested: 2,
        dates_scraped: 2,
        searches_attempted: 10,
        searches_failed: 0,
        blocked: false,
        failed_searches: [],
      },
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await scrapeMarketPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(marketScraperModule.scrapeMarketPrices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        market: expect.objectContaining({
          location: 'Portland, Maine',
          hotel_names: ['Waterfront Hotel'],
        }),
      }),
    );
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ schema_version: 1, success: true }));
  });

  it('maps Airbnb block detection to a retry-friendly rate-limit response', async () => {
    vi.mocked(marketScraperModule.scrapeMarketPrices).mockRejectedValueOnce(
      new MarketScrapeError('blocked_by_airbnb'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await scrapeMarketPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(429);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: 'blocked_by_airbnb',
      message: 'blocked_by_airbnb',
    });
  });
});
