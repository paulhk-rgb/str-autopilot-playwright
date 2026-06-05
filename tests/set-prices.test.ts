import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/set-prices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright/set-prices')>();
  return {
    ...actual,
    setCalendarPrices: vi.fn(),
  };
});

import { __resetSingleFlightForTesting } from '../src/lib/single-flight';
import { __setPricesEndpointTestHooks, setPricesHandler } from '../src/endpoints/set-prices';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';
import * as browserModule from '../src/playwright/browser';
import {
  BrowserSetPricesError,
  __setPricesBrowserTestHooks,
} from '../src/playwright/set-prices';
import * as setPricesModule from '../src/playwright/set-prices';

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
  schema_version: 1,
  host_id: HOST_ID,
  property_id: 'property-1',
  listing_id: '1234567890123456789',
  currency: 'USD',
  idempotency_key: 'host-property-listing-prices-2026-06-01',
  dry_run: false,
  price_bounds: {
    min: 50,
    max: 900,
    currency: 'USD',
  },
  dates: [
    {
      date: '2026-06-05',
      plan_id: 'plan-1',
      plan_version: 1,
      price: 225,
    },
  ],
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
  vi.unstubAllEnvs();
  __resetSingleFlightForTesting();
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.readAirbnbSessionStrict).mockReset();
  vi.mocked(setPricesModule.setCalendarPrices).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
});

describe('/set-prices endpoint guards', () => {
  it('accepts the gated price-write contract shape', () => {
    expect(__setPricesEndpointTestHooks.validateSetPricesBody(validBody)).toEqual({ ok: true });
  });

  it('rejects duplicate dates before any browser work can happen', () => {
    expect(__setPricesEndpointTestHooks.validateSetPricesBody({
      ...validBody,
      dates: [
        validBody.dates[0],
        { ...validBody.dates[0], plan_id: 'plan-2' },
      ],
    })).toEqual({ ok: false, reason: 'duplicate_date' });
  });

  it('rejects oversized write batches', () => {
    expect(__setPricesEndpointTestHooks.validateSetPricesBody({
      ...validBody,
      dates: Array.from({ length: __setPricesEndpointTestHooks.MAX_WRITE_DATES + 1 }, (_, index) => ({
        date: `2026-06-${String(index + 1).padStart(2, '0')}`,
        plan_id: `plan-${index + 1}`,
        plan_version: 1,
        price: 225,
      })),
    })).toEqual({ ok: false, reason: 'request_too_large' });
  });

  it('requires app-supplied currency-aware price bounds', () => {
    expect(__setPricesEndpointTestHooks.validateSetPricesBody({
      ...validBody,
      price_bounds: {
        min: 50,
        max: 900,
        currency: 'CAD',
      },
    })).toEqual({ ok: false, reason: 'unsupported_currency' });

    expect(__setPricesEndpointTestHooks.validateSetPricesBody({
      ...validBody,
      dates: [{ ...validBody.dates[0], price: 25 }],
    })).toEqual({ ok: false, reason: 'invalid_value' });
  });

  it('rejects prices above the worker-side absolute nightly ceiling', () => {
    expect(__setPricesEndpointTestHooks.validateSetPricesBody({
      ...validBody,
      price_bounds: {
        ...validBody.price_bounds,
        max: __setPricesEndpointTestHooks.MAX_ABSOLUTE_NIGHTLY_PRICE + 1,
      },
      dates: [
        {
          ...validBody.dates[0],
          price: __setPricesEndpointTestHooks.MAX_ABSOLUTE_NIGHTLY_PRICE + 1,
        },
      ],
    })).toEqual({ ok: false, reason: 'unsupported_currency' });

    expect(__setPricesEndpointTestHooks.validateSetPricesBody({
      ...validBody,
      price_bounds: {
        ...validBody.price_bounds,
        max: __setPricesEndpointTestHooks.MAX_ABSOLUTE_NIGHTLY_PRICE,
      },
      dates: [
        {
          ...validBody.dates[0],
          price: __setPricesEndpointTestHooks.MAX_ABSOLUTE_NIGHTLY_PRICE + 1,
        },
      ],
    })).toEqual({ ok: false, reason: 'invalid_value' });
  });

  it('rejects host mismatches before reporting implementation status', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      ...validBody,
      host_id: 'other-host',
    });

    await setPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: 'host_id_mismatch',
    }));
  });

  it('fails closed until browser price writes are explicitly enabled', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(501);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      schema_version: 1,
      error: 'pricing_write_not_implemented',
      results: [
        expect.objectContaining({
          date: '2026-06-05',
          status: 'failed',
          verified: false,
          requested_price: 225,
          reason: 'pricing_write_not_implemented',
        }),
      ],
    }));
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
    expect(setPricesModule.setCalendarPrices).not.toHaveBeenCalled();
  });

  it('checks Airbnb session and calls the browser setter only when explicitly enabled', async () => {
    vi.stubEnv('STAYSYNC_PRICING_BROWSER_SET_PRICES_ENABLED', 'true');
    vi.mocked(setPricesModule.setCalendarPrices).mockResolvedValueOnce({
      success: true,
      schema_version: 1,
      host_id: HOST_ID,
      listing_id: validBody.listing_id,
      currency: validBody.currency,
      dry_run: false,
      session_listing_verified: true,
      smart_pricing_enabled: false,
      results: [
        {
          date: '2026-06-05',
          status: 'applied',
          verified: true,
          requested_price: 225,
          observed_price: 225,
          previous_price: 215,
          currency: 'USD',
        },
      ],
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(browserModule.readAirbnbSessionStrict).toHaveBeenCalled();
    expect(setPricesModule.setCalendarPrices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        request: validBody,
        allowSmartPricingToggle: false,
      }),
    );
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      schema_version: 1,
      smart_pricing_enabled: false,
    }));
  });

  it('maps missing Airbnb session cookies to invalid_cookies before opening the setter', async () => {
    vi.stubEnv('STAYSYNC_PRICING_BROWSER_SET_PRICES_ENABLED', 'true');
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies', reason: 'invalid_cookies' });
    expect(setPricesModule.setCalendarPrices).not.toHaveBeenCalled();
  });

  it('maps listing mismatch from the browser setter without marking dates verified', async () => {
    vi.stubEnv('STAYSYNC_PRICING_BROWSER_SET_PRICES_ENABLED', 'true');
    vi.mocked(setPricesModule.setCalendarPrices).mockRejectedValueOnce(
      new BrowserSetPricesError('listing_mismatch'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setPricesHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: 'listing_mismatch',
      results: [
        expect.objectContaining({
          date: '2026-06-05',
          verified: false,
          reason: 'listing_mismatch',
        }),
      ],
    }));
  });
});

describe('browser set-prices helpers', () => {
  it('parses whole-dollar Airbnb price input and display text', () => {
    expect(__setPricesBrowserTestHooks.parsePrice('$1,250.00')).toBe(1250);
    expect(__setPricesBrowserTestHooks.parsePrice('€150')).toBe(150);
    expect(__setPricesBrowserTestHooks.parsePrice('150 €')).toBe(150);
    expect(__setPricesBrowserTestHooks.parsePrice('CA$175')).toBe(175);
    expect(__setPricesBrowserTestHooks.parsePrice('175 CAD')).toBe(175);
    expect(__setPricesBrowserTestHooks.parsePrice('225')).toBe(225);
    expect(__setPricesBrowserTestHooks.parsePrice('2 nights')).toBeNull();
    expect(__setPricesBrowserTestHooks.parsePrice('215 2 NIGHTS')).toBeNull();
    expect(__setPricesBrowserTestHooks.parsePrice('215,50 €')).toBeNull();
    expect(__setPricesBrowserTestHooks.parsePrice('€215,50')).toBeNull();
    expect(__setPricesBrowserTestHooks.parsePrice('not a price')).toBeNull();
    expect(__setPricesBrowserTestHooks.chooseBestPrice('$215', '$300 in sidebar')).toBe(215);
  });

  it('classifies booked and blocked sidebar text conservatively', () => {
    expect(__setPricesBrowserTestHooks.classifyDateState('Currently hosting Alice Check-in Checkout')).toBe('booked');
    expect(__setPricesBrowserTestHooks.classifyDateState('This date is blocked by you')).toBe('blocked');
    expect(__setPricesBrowserTestHooks.classifyDateState('Nightly price $215 Minimum stay 2 nights')).toBe('open');
  });
});
