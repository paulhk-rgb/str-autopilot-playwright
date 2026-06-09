import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/scrape-calendar-prices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright/scrape-calendar-prices')>();
  return {
    ...actual,
    scrapeCalendarPrices: vi.fn(),
  };
});

import { scrapeCalendarPricesHandler } from '../src/endpoints/scrape-calendar-prices';
import * as browserModule from '../src/playwright/browser';
import * as calendarScraperModule from '../src/playwright/scrape-calendar-prices';
import {
  __calendarPriceScraperTestHooks,
  CalendarPriceScrapeError,
} from '../src/playwright/scrape-calendar-prices';
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
  listing_id: '1234567890123456789',
  start_date: '2026-06-05',
  end_date: '2026-06-07',
  currency: 'USD',
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
  vi.mocked(calendarScraperModule.scrapeCalendarPrices).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
});

describe('calendar price scraper guards', () => {
  it('normalizes listing/date ranges and currency', () => {
    expect(__calendarPriceScraperTestHooks.normalizeCalendarPriceRequest({
      listing_id: '12345678',
      start_date: '2026-06-01',
      end_date: '2026-06-03',
      currency: 'usd',
    })).toEqual({
      listing_id: '12345678',
      start_date: '2026-06-01',
      end_date: '2026-06-03',
      currency: 'USD',
    });

    expect(__calendarPriceScraperTestHooks.dateRange('2026-06-01', '2026-06-03')).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('rejects malformed listing/date ranges before browser work', () => {
    expect(() => __calendarPriceScraperTestHooks.normalizeCalendarPriceRequest({
      listing_id: 'not-a-number',
      start_date: '2026-06-01',
      end_date: '2026-06-03',
    })).toThrow('invalid_listing_id');
    expect(() => __calendarPriceScraperTestHooks.normalizeCalendarPriceRequest({
      listing_id: '12345678',
      start_date: '2026-02-30',
      end_date: '2026-06-03',
    })).toThrow('invalid_date');
    expect(() => __calendarPriceScraperTestHooks.normalizeCalendarPriceRequest({
      listing_id: '12345678',
      start_date: '2026-06-03',
      end_date: '2026-06-01',
    })).toThrow('invalid_date_range');
    expect(() => __calendarPriceScraperTestHooks.normalizeCalendarPriceRequest({
      listing_id: '12345678',
      start_date: '2026-06-01',
      end_date: '2026-09-15',
    })).toThrow('date_range_too_large');
  });

  it('builds the Airbnb multicalendar URL from the supplied listing id only', () => {
    expect(__calendarPriceScraperTestHooks.buildMulticalendarUrl('12345678')).toBe(
      'https://www.airbnb.com/multicalendar/12345678',
    );
  });

  it('fails closed when Airbnb redirects away from the requested listing calendar', () => {
    expect(() => __calendarPriceScraperTestHooks.assertCalendarUrlMatchesListing(
      'https://www.airbnb.com/multicalendar/12345678',
      '12345678',
    )).not.toThrow();
    expect(() => __calendarPriceScraperTestHooks.assertCalendarUrlMatchesListing(
      'https://www.airbnb.com/hosting',
      '12345678',
    )).toThrow('listing_mismatch');
    expect(() => __calendarPriceScraperTestHooks.assertCalendarUrlMatchesListing(
      'https://www.airbnb.com/multicalendar/123456789',
      '12345678',
    )).toThrow('listing_mismatch');
  });

  it('fails closed when the calendar page becomes blocked mid-scrape', async () => {
    const blockedPage = {
      url: () => 'https://www.airbnb.com/multicalendar/12345678',
      evaluate: vi.fn().mockResolvedValue(true),
    };

    await expect(
      __calendarPriceScraperTestHooks.assertCalendarPageStillSafe(blockedPage as never, '12345678'),
    ).rejects.toThrow('blocked_by_airbnb');
  });

  it('parses sidebar price and minimum stay text conservatively', () => {
    expect(__calendarPriceScraperTestHooks.parsePrice('Nightly price $215.00')).toBe(215);
    expect(__calendarPriceScraperTestHooks.chooseCalendarPrice('$195', 'Price settings $125 – $460 per night')).toBe(195);
    expect(__calendarPriceScraperTestHooks.parseMinStay('Minimum stay 2 nights')).toBe(2);
    expect(__calendarPriceScraperTestHooks.parseMinStay('3 nights minimum')).toBe(3);
    expect(__calendarPriceScraperTestHooks.isBookedDateText('Currently hosting Alice')).toBe(true);
    expect(__calendarPriceScraperTestHooks.isBlockedDateText('Blocked by host')).toBe(true);
  });
});

describe('/scrape-calendar-prices endpoint', () => {
  it('rejects malformed bodies before opening the browser', async () => {
    const { req, res, statusSpy } = buildReqRes({
      ...validBody,
      listing_id: 'not-a-number',
    });

    await scrapeCalendarPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
  });

  it('rejects host mismatches', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      ...validBody,
      host_id: 'other-host',
    });

    await scrapeCalendarPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'host_id_mismatch' });
  });

  it('maps missing Airbnb session cookies to invalid_cookies', async () => {
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await scrapeCalendarPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(calendarScraperModule.scrapeCalendarPrices).not.toHaveBeenCalled();
  });

  it('returns calendar scrape results for the supplied listing/date range', async () => {
    vi.mocked(calendarScraperModule.scrapeCalendarPrices).mockResolvedValueOnce({
      success: true,
      schema_version: 1,
      listing_id: validBody.listing_id,
      start_date: validBody.start_date,
      end_date: validBody.end_date,
      scraped_at: '2026-06-01T00:00:00.000Z',
      smart_pricing_enabled: false,
      prices: [
        {
          date: '2026-06-05',
          price: 215,
          min_stay: 2,
          is_booked: false,
          is_blocked: false,
          currency: 'USD',
        },
      ],
      diagnostics: {
        dates_requested: 3,
        dates_scraped: 1,
        missing_dates: ['2026-06-06', '2026-06-07'],
        blocked: false,
      },
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await scrapeCalendarPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(calendarScraperModule.scrapeCalendarPrices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        request: expect.objectContaining({
          listing_id: validBody.listing_id,
          start_date: validBody.start_date,
          end_date: validBody.end_date,
        }),
      }),
    );
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ schema_version: 1, success: true }));
  });

  it('maps Airbnb block detection to a retry-friendly rate-limit response', async () => {
    vi.mocked(calendarScraperModule.scrapeCalendarPrices).mockRejectedValueOnce(
      new CalendarPriceScrapeError('blocked_by_airbnb'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await scrapeCalendarPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(429);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: 'blocked_by_airbnb',
      message: 'blocked_by_airbnb',
    });
  });

  it('maps no visible calendar dates to an upstream scrape failure', async () => {
    vi.mocked(calendarScraperModule.scrapeCalendarPrices).mockRejectedValueOnce(
      new CalendarPriceScrapeError('no_dates_found'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await scrapeCalendarPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: 'no_dates_found',
      message: 'no_dates_found',
    });
  });
});
