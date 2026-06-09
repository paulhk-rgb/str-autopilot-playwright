import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/set-minimum-stays', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright/set-minimum-stays')>();
  return {
    ...actual,
    setCalendarMinimumStays: vi.fn(),
  };
});

import { __resetSingleFlightForTesting } from '../src/lib/single-flight';
import {
  __setMinimumStaysEndpointTestHooks,
  setMinimumStaysHandler,
} from '../src/endpoints/set-minimum-stays';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';
import * as browserModule from '../src/playwright/browser';
import {
  BrowserSetMinimumStaysError,
  __setMinimumStaysBrowserTestHooks,
} from '../src/playwright/set-minimum-stays';
import * as setMinimumStaysModule from '../src/playwright/set-minimum-stays';

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
  idempotency_key: 'host-property-listing-min-stays-2026-06-01',
  dry_run: false,
  dates: [
    {
      date: '2026-06-05',
      plan_id: 'plan-1',
      plan_version: 1,
      min_stay: 2,
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
  vi.mocked(setMinimumStaysModule.setCalendarMinimumStays).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
});

describe('/set-minimum-stays endpoint guards', () => {
  it('accepts the gated minimum-stay write contract shape', () => {
    expect(__setMinimumStaysEndpointTestHooks.validateSetMinimumStaysBody(validBody)).toEqual({ ok: true });
  });

  it('rejects duplicate dates before browser work can happen', () => {
    expect(__setMinimumStaysEndpointTestHooks.validateSetMinimumStaysBody({
      ...validBody,
      dates: [
        validBody.dates[0],
        { ...validBody.dates[0], plan_id: 'plan-2' },
      ],
    })).toEqual({ ok: false, reason: 'duplicate_date' });
  });

  it('rejects oversized write batches', () => {
    expect(__setMinimumStaysEndpointTestHooks.validateSetMinimumStaysBody({
      ...validBody,
      dates: Array.from({ length: __setMinimumStaysEndpointTestHooks.MAX_WRITE_DATES + 1 }, (_, index) => ({
        date: `2026-06-${String(index + 1).padStart(2, '0')}`,
        plan_id: `plan-${index + 1}`,
        plan_version: 1,
        min_stay: 2,
      })),
    })).toEqual({ ok: false, reason: 'request_too_large' });
  });

  it('rejects invalid minimum-stay values', () => {
    expect(__setMinimumStaysEndpointTestHooks.validateSetMinimumStaysBody({
      ...validBody,
      dates: [{ ...validBody.dates[0], min_stay: 0 }],
    })).toEqual({ ok: false, reason: 'invalid_value' });

    expect(__setMinimumStaysEndpointTestHooks.validateSetMinimumStaysBody({
      ...validBody,
      dates: [{ ...validBody.dates[0], min_stay: 31 }],
    })).toEqual({ ok: false, reason: 'invalid_value' });
  });

  it('fails closed unless browser minimum-stay writes are explicitly enabled', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setMinimumStaysHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(501);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      schema_version: 1,
      error: 'minimum_stay_write_not_enabled',
      results: [
        expect.objectContaining({
          date: '2026-06-05',
          status: 'failed',
          verified: false,
          requested_min_stay: 2,
          reason: 'minimum_stay_write_not_enabled',
        }),
      ],
    }));
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
    expect(setMinimumStaysModule.setCalendarMinimumStays).not.toHaveBeenCalled();
  });

  it('checks Airbnb session and calls the browser setter only when explicitly enabled', async () => {
    vi.stubEnv('STAYSYNC_PRICING_BROWSER_SET_MINIMUM_STAYS_ENABLED', 'true');
    vi.mocked(setMinimumStaysModule.setCalendarMinimumStays).mockResolvedValueOnce({
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
          requested_min_stay: 2,
          observed_min_stay: 2,
          previous_min_stay: 1,
          currency: 'USD',
        },
      ],
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setMinimumStaysHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(browserModule.readAirbnbSessionStrict).toHaveBeenCalled();
    expect(setMinimumStaysModule.setCalendarMinimumStays).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ request: validBody }),
    );
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      schema_version: 1,
      smart_pricing_enabled: false,
    }));
  });

  it('maps missing Airbnb session cookies to invalid_cookies before opening the setter', async () => {
    vi.stubEnv('STAYSYNC_PRICING_BROWSER_SET_MINIMUM_STAYS_ENABLED', 'true');
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setMinimumStaysHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies', reason: 'invalid_cookies' });
    expect(setMinimumStaysModule.setCalendarMinimumStays).not.toHaveBeenCalled();
  });

  it('maps listing mismatch from the browser setter without marking dates verified', async () => {
    vi.stubEnv('STAYSYNC_PRICING_BROWSER_SET_MINIMUM_STAYS_ENABLED', 'true');
    vi.mocked(setMinimumStaysModule.setCalendarMinimumStays).mockRejectedValueOnce(
      new BrowserSetMinimumStaysError('listing_mismatch'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody);

    await setMinimumStaysHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: 'listing_mismatch',
      results: [
        expect.objectContaining({
          date: '2026-06-05',
          verified: false,
          requested_min_stay: 2,
          reason: 'listing_mismatch',
        }),
      ],
    }));
  });
});

describe('browser set-minimum-stays helpers', () => {
  it('parses minimum-stay input and sidebar text conservatively', () => {
    expect(__setMinimumStaysBrowserTestHooks.parseMinimumStay('2')).toBe(2);
    expect(__setMinimumStaysBrowserTestHooks.parseMinimumStay('Minimum stay 3 nights')).toBe(3);
    expect(__setMinimumStaysBrowserTestHooks.parseMinimumStay('Trip length 1 night')).toBe(1);
    expect(__setMinimumStaysBrowserTestHooks.parseMinimumStay('2 nights minimum')).toBe(2);
    expect(__setMinimumStaysBrowserTestHooks.parseMinimumStay('31')).toBeNull();
    expect(__setMinimumStaysBrowserTestHooks.parseMinimumStay('$215')).toBeNull();
    expect(__setMinimumStaysBrowserTestHooks.parseMinimumStay('1 - 365 night stays')).toBeNull();
  });

  it('classifies booked and blocked sidebar text conservatively', () => {
    expect(__setMinimumStaysBrowserTestHooks.classifyDateState('Currently hosting Alice Check-in Checkout')).toBe('booked');
    expect(__setMinimumStaysBrowserTestHooks.classifyDateState('This date is blocked by you')).toBe('blocked');
    expect(__setMinimumStaysBrowserTestHooks.classifyDateState('Nightly price $215 Minimum stay 2 nights')).toBe('open');
  });
});
