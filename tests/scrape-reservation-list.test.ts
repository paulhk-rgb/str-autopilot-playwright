/**
 * /scrape-reservation-list endpoint tests.
 *
 * Handler-level coverage bypasses HMAC middleware so validation, host binding,
 * auth-epoch guards, and the schema-v3 response contract can be tested directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';
import type { ScrapeReservationsResult } from '../src/playwright/scrape-reservations';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/scrape-reservations', () => ({
  ReservationListCursorError: class ReservationListCursorError extends Error {
    constructor(message = 'reservation_list_cursor_invalid') {
      super(message);
      this.name = 'ReservationListCursorError';
    }
  },
  scrapeReservationList: vi.fn(),
}));

import { scrapeReservationListHandler } from '../src/endpoints/scrape-reservation-list';
import * as browserModule from '../src/playwright/browser';
import * as scraperModule from '../src/playwright/scrape-reservations';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';

const HOST_ID = '11111111-2222-3333-4444-555555555555';
const VALID_BODY = {
  host_id: HOST_ID,
  mode: 'full' as const,
  window_start: '2026-01-01',
  window_end: '2026-12-31',
  cursor: null,
};

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

function scrapeResult(overrides: Partial<ScrapeReservationsResult> = {}): ScrapeReservationsResult {
  return {
    schema_version: 3,
    mode: 'full',
    window_start: '2026-01-01',
    window_end: '2026-12-31',
    page_cursor: null,
    next_page_cursor: null,
    page_index: 0,
    is_complete: true,
    scraped_at: '2026-04-28T00:00:00.000Z',
    reservations: [],
    diagnostics: { source: 'test' },
    ...overrides,
  };
}

function buildReqRes(body: unknown): {
  req: Request;
  res: Response;
  jsonSpy: ReturnType<typeof vi.fn>;
  statusSpy: ReturnType<typeof vi.fn>;
  setHeaderSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn();
  const setHeaderSpy = vi.fn();
  const res = {
    status: vi.fn(),
    json: jsonSpy,
    setHeader: setHeaderSpy,
  } as unknown as Response & { status: ReturnType<typeof vi.fn> };
  res.status.mockImplementation(() => res);
  const req = { body } as Request;
  return { req, res, jsonSpy, statusSpy: res.status, setHeaderSpy };
}

beforeEach(() => {
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.readAirbnbSessionStrict).mockReset();
  vi.mocked(scraperModule.scrapeReservationList).mockReset();
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();
});

describe('scrapeReservationListHandler', () => {
  it('returns 400 when body is missing required v2 fields', async () => {
    const { req, res, jsonSpy, statusSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_body' });
  });

  it.each([
    ['unknown mode', { ...VALID_BODY, mode: 'turbo' }],
    ['bad start date', { ...VALID_BODY, window_start: '2026-02-31' }],
    ['bad end date', { ...VALID_BODY, window_end: '2026-13-01' }],
    ['end before start', { ...VALID_BODY, window_start: '2026-05-01', window_end: '2026-04-30' }],
    ['non-string cursor', { ...VALID_BODY, cursor: 12345 }],
  ])('returns 400 for malformed body: %s', async (_name, body) => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes(body);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_body' });
  });

  it('returns 403 when host_id does not match machine HOST_ID', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      ...VALID_BODY,
      host_id: '99999999-9999-9999-9999-999999999999',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'host_id_mismatch' });
  });

  it('returns 500 with browser_failed when getBrowserContext throws', async () => {
    vi.mocked(browserModule.getBrowserContext).mockRejectedValue(new Error('chromium dead'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'browser_failed', message: 'chromium dead' }),
    );
  });

  it('returns 503 auth_epoch_changed when getBrowserContext throws and epoch rotated', async () => {
    vi.mocked(browserModule.getBrowserContext).mockImplementation(async () => {
      beginCookieInject();
      throw new Error('Target closed');
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
    expect(browserModule.readAirbnbSessionStrict).not.toHaveBeenCalled();
  });

  it('returns 503 auth_epoch_not_ready when /inject-cookies has not completed', async () => {
    _resetAuthEpochForTesting();
    beginCookieInject();
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_not_ready' });
    expect(scraperModule.scrapeReservationList).not.toHaveBeenCalled();
  });

  it('returns 401 invalid_cookies when no Airbnb session is present', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(scraperModule.scrapeReservationList).not.toHaveBeenCalled();
  });

  it('serves on fresh-process state when persisted profile cookies are valid', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue(scrapeResult());
    _resetAuthEpochForTesting();
    const { req, res, statusSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it('returns 503 auth_epoch_changed when epoch rotates between getBrowserContext and session check', async () => {
    vi.mocked(browserModule.getBrowserContext).mockImplementation(async () => {
      beginCookieInject();
      return {} as never;
    });
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
    expect(browserModule.readAirbnbSessionStrict).not.toHaveBeenCalled();
    expect(scraperModule.scrapeReservationList).not.toHaveBeenCalled();
  });

  it('returns 503 auth_epoch_changed when readAirbnbSessionStrict throws and epoch rotated', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockImplementation(async () => {
      beginCookieInject();
      throw new Error('cookie store closed');
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
  });

  it('returns 503 auth_epoch_changed when session check returns true but epoch rotated', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockImplementation(async () => {
      beginCookieInject();
      return true;
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
    expect(scraperModule.scrapeReservationList).not.toHaveBeenCalled();
  });

  it('returns 503 auth_epoch_changed when scraper throws and epoch rotated mid-scrape', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockImplementation(async () => {
      beginCookieInject();
      throw new Error('Target closed');
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
  });

  it('returns 500 with scrape_failed when scraper throws', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockRejectedValue(new Error('dom not found'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'scrape_failed', message: 'dom not found' }),
    );
  });

  it('returns 401 invalid_cookies when Airbnb API auth fails inside the scraper', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockRejectedValue(
      new Error('reservation_list_api_auth_failed:401'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
  });

  it('does not allow reservation-list API auth failures to fall through to DOM fallback', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');

    expect(
      __reservationScraperTestHooks.isReservationListApiAuthError(
        new Error('reservation_list_api_auth_failed:401'),
      ),
    ).toBe(true);
    expect(
      __reservationScraperTestHooks.isReservationListApiAuthError(
        new Error('reservation_list_api_failed:500'),
      ),
    ).toBe(false);
  });

  it('returns schema-v3 body and does not emit the removed X-Stub header', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue(
      scrapeResult({
        reservations: [
          {
            conf_code: 'HMABC123',
            guest_name: 'Test Guest',
            check_in: '2026-05-01',
            check_out: '2026-05-04',
            status_text: 'accepted',
            listing_id: '123',
            listing_name: 'Lake House',
            guest_count: 2,
            total_payout: 450,
            guest_paid: 520,
            reservation_url: 'https://www.airbnb.com/hosting/reservations/details/HMABC123',
            conversation_airbnb_id: 't1',
          },
        ],
      }),
    );

    const { req, res, statusSpy, jsonSpy, setHeaderSpy } = buildReqRes(VALID_BODY);
    await scrapeReservationListHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeReservationList).toHaveBeenCalledWith(expect.anything(), {
      mode: 'full',
      window_start: '2026-01-01',
      window_end: '2026-12-31',
      cursor: null,
      apiKey: 'k',
      cursorSecret: env.HMAC_SECRET,
    });
    expect(jsonSpy).toHaveBeenCalledWith({
      schema_version: 3,
      mode: 'full',
      window_start: '2026-01-01',
      window_end: '2026-12-31',
      page_cursor: null,
      next_page_cursor: null,
      page_index: 0,
      is_complete: true,
      scraped_at: '2026-04-28T00:00:00.000Z',
      reservations: [
        {
          conf_code: 'HMABC123',
          guest_name: 'Test Guest',
          check_in: '2026-05-01',
          check_out: '2026-05-04',
          status_text: 'accepted',
          listing_id: '123',
          listing_name: 'Lake House',
          guest_count: 2,
          total_payout: 450,
          guest_paid: 520,
          reservation_url: 'https://www.airbnb.com/hosting/reservations/details/HMABC123',
          conversation_airbnb_id: 't1',
        },
      ],
      diagnostics: { source: 'test' },
    });
    expect(setHeaderSpy).not.toHaveBeenCalledWith('X-Stub', expect.anything());
  });

  it('returns 400 when the scraper rejects a tampered signed cursor', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    const ReservationListCursorError = (
      scraperModule as unknown as {
        ReservationListCursorError: new () => Error;
      }
    ).ReservationListCursorError;
    vi.mocked(scraperModule.scrapeReservationList).mockRejectedValue(
      new ReservationListCursorError(),
    );

    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      ...VALID_BODY,
      cursor: 'rsv-v1.abc.def',
    });
    await scrapeReservationListHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_cursor' });
  });
});

describe('reservation-list scraper pure extraction helpers', () => {
  it('builds the Airbnb reservations API URL with Airbnb organic reservation statuses', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');

    expect(__reservationScraperTestHooks.reservationsApiUrl(40)).toBe(
      'https://www.airbnb.com/api/v2/reservations?locale=en&currency=USD&_format=for_remy&_limit=40&_offset=40&collection_strategy=for_reservations_list&sort_field=start_date&sort_order=desc&status=accepted,request,canceled',
    );
  });

  it('computes the conservative API stop boundary and page max check-in date', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');

    expect(__reservationScraperTestHooks.subtractDaysFromDateOnly('2025-01-01', 400)).toBe('2023-11-28');
    expect(
      __reservationScraperTestHooks.maxApiRowCheckIn([
        { start_date: '2024-04-24' },
        { checkIn: { year: 2023, month: 12, day: 1 } },
        { check_in: '2024-01-03' },
      ]),
    ).toBe('2024-04-24');
  });

  it('rejects impossible calendar dates while normalizing supported date shapes', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');

    expect(__reservationScraperTestHooks.normalizeDate('2/29/2024')).toBe('2024-02-29');
    expect(__reservationScraperTestHooks.normalizeDate('2/29/2025')).toBeNull();
    expect(__reservationScraperTestHooks.normalizeDate('Apr 31, 2026')).toBeNull();
    expect(__reservationScraperTestHooks.normalizeDate('Apr 30, 2026')).toBe('2026-04-30');
  });

  it('signs reservation-list cursors, rejects tampering, and tolerates moving window dates', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const opts = {
      mode: 'full' as const,
      window_start: '2026-01-01',
      window_end: '2026-12-31',
      cursor: null,
      apiKey: 'k',
      cursorSecret: env.HMAC_SECRET,
    };
    const cursor = __reservationScraperTestHooks.encodeReservationListCursor(
      {
        v: 1,
        mode: 'full',
        window_start: '2026-01-01',
        window_end: '2026-12-31',
        offset: 40,
        page_index: 1,
      },
      env.HMAC_SECRET,
    );

    expect(
      __reservationScraperTestHooks.decodeReservationListCursor(cursor, {
        ...opts,
        cursor,
      }),
    ).toEqual({
      v: 1,
      mode: 'full',
      window_start: '2026-01-01',
      window_end: '2026-12-31',
      offset: 40,
      page_index: 1,
    });
    expect(() =>
      __reservationScraperTestHooks.decodeReservationListCursor(`${cursor}x`, {
        ...opts,
        cursor: `${cursor}x`,
      }),
    ).toThrow('reservation_list_cursor_invalid');
    expect(
      __reservationScraperTestHooks.decodeReservationListCursor(cursor, {
        ...opts,
        cursor,
        window_end: '2027-12-31',
      }),
    ).toEqual(
      expect.objectContaining({
        offset: 40,
        page_index: 1,
      }),
    );
  });

  it('accepts an empty terminal API page during signed-cursor resumes', async () => {
    const { __reservationScraperTestHooks, scrapeReservationList } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const cursor = __reservationScraperTestHooks.encodeReservationListCursor(
      {
        v: 1,
        mode: 'full',
        window_start: '2026-01-01',
        window_end: '2026-12-31',
        offset: 40,
        page_index: 1,
      },
      env.HMAC_SECRET,
    );
    const page = { close: vi.fn().mockResolvedValue(undefined) };
    const ctx = {
      newPage: vi.fn().mockResolvedValue(page),
      request: {
        get: vi.fn().mockResolvedValue({
          status: () => 200,
          text: async () => JSON.stringify({ reservations: [], metadata: { total_count: 40 } }),
        }),
      },
    };

    const result = await scrapeReservationList(ctx as never, {
      mode: 'full',
      window_start: '2026-01-01',
      window_end: '2026-12-31',
      cursor,
      apiKey: 'k',
      cursorSecret: env.HMAC_SECRET,
    });

    expect(result.is_complete).toBe(true);
    expect(result.next_page_cursor).toBeNull();
    expect(result.page_index).toBe(1);
    expect(result.reservations).toEqual([]);
  });

  it('preserves API failures during signed-cursor resumes instead of masking them as fallback errors', async () => {
    const { __reservationScraperTestHooks, scrapeReservationList } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const cursor = __reservationScraperTestHooks.encodeReservationListCursor(
      {
        v: 1,
        mode: 'full',
        window_start: '2026-01-01',
        window_end: '2026-12-31',
        offset: 40,
        page_index: 1,
      },
      env.HMAC_SECRET,
    );
    const page = { close: vi.fn().mockResolvedValue(undefined) };
    const ctx = {
      newPage: vi.fn().mockResolvedValue(page),
      request: {
        get: vi.fn().mockResolvedValue({
          status: () => 429,
          text: async () => JSON.stringify({ error: 'rate_limited' }),
        }),
      },
    };

    await expect(
      scrapeReservationList(ctx as never, {
        mode: 'full',
        window_start: '2026-01-01',
        window_end: '2026-12-31',
        cursor,
        apiKey: 'k',
        cursorSecret: env.HMAC_SECRET,
      }),
    ).rejects.toThrow('reservation_list_api_failed:429');
  });

  it('extracts nested reservation JSON, normalizes codes, and filters by window', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const reservations = __reservationScraperTestHooks.collectJsonReservations({
      data: {
        node: {
          confirmationCode: 'hmabc123',
          guest: { firstName: 'Ada', lastName: 'Lovelace' },
          checkIn: { year: 2026, month: 5, day: 1 },
          checkOut: '2026-05-04T11:00:00Z',
          statusText: 'Confirmed',
          listing: { id: 'listing-1', name: 'Lake House' },
          guestDetails: { numberOfGuests: 3 },
          payout: { amount: '$1,234.50' },
          guestTotal: { amount: '1500' },
          threadId: 'thread-1',
        },
      },
    });

    expect(reservations).toEqual([
      expect.objectContaining({
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Confirmed',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
        guest_count: 3,
        total_payout: 1234.5,
        guest_paid: 1500,
        conversation_airbnb_id: 'thread-1',
      }),
    ]);
    expect(
      __reservationScraperTestHooks.filterByWindow(reservations, '2026-05-02', '2026-05-02'),
    ).toHaveLength(1);
    expect(
      __reservationScraperTestHooks.filterByWindow(
        [
          {
            ...reservations[0],
            check_in: '2025-12-20',
            check_out: '2026-01-05',
          },
        ],
        '2026-01-01',
        '2026-01-31',
      ),
    ).toHaveLength(1);
    expect(
      __reservationScraperTestHooks.filterByWindow(reservations, '2026-06-01', '2026-06-30'),
    ).toHaveLength(0);
  });

  it('extracts Airbnb /api/v2/reservations for_remy rows', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const reservations = __reservationScraperTestHooks.collectJsonReservations({
      reservations: [
        {
          confirmation_code: 'hm3zxpmnzc',
          start_date: '2026-05-22',
          end_date: '2026-05-24',
          listing_id: 1238734339606310870,
          listing_id_str: '1238734339606310870',
          listing_name: 'One Bedroom Private Unit',
          guest_user: { full_name: 'Alice Example' },
          guest_details: { number_of_guests: 3 },
          earnings: '$1,071.85',
          user_facing_status_localized: 'Confirmed',
          bessie_thread_id: 987654321,
        },
      ],
    });

    expect(reservations).toEqual([
      expect.objectContaining({
        conf_code: 'HM3ZXPMNZC',
        guest_name: 'Alice Example',
        check_in: '2026-05-22',
        check_out: '2026-05-24',
        status_text: 'Confirmed',
        listing_id: '1238734339606310870',
        listing_name: 'One Bedroom Private Unit',
        guest_count: 3,
        total_payout: 1071.85,
        reservation_url: 'https://www.airbnb.com/hosting/reservations/details/HM3ZXPMNZC',
        conversation_airbnb_id: '987654321',
      }),
    ]);
  });

  it('deduplicates by confirmation code while preserving richer later values', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const merged = __reservationScraperTestHooks.mergeReservations([
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Unknown',
        listing_id: null,
        listing_name: null,
      },
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Confirmed',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
      },
    ]);

    expect(merged).toEqual([
      expect.objectContaining({
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        status_text: 'Confirmed',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
      }),
    ]);
  });

  it('does not let a degraded DOM row overwrite a better API status', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const merged = __reservationScraperTestHooks.mergeReservations([
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Confirmed',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
      },
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Unknown',
        listing_id: null,
        listing_name: null,
      },
    ]);

    expect(merged[0].status_text).toBe('Confirmed');
  });

  it('does not let weaker duplicate fragments clobber richer reservation values', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const merged = __reservationScraperTestHooks.mergeReservations([
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Confirmed',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
        total_payout: 1234.5,
      },
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Unknown',
        listing_id: 'listing-1',
        listing_name: 'Lake',
        total_payout: 0,
      },
    ]);

    expect(merged[0]).toEqual(
      expect.objectContaining({
        guest_name: 'Ada Lovelace',
        listing_name: 'Lake House',
        status_text: 'Confirmed',
        total_payout: 1234.5,
      }),
    );
  });

  it('keeps cancellation status ahead of later lower-precedence statuses', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const merged = __reservationScraperTestHooks.mergeReservations([
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Cancelled by guest',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
      },
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Confirmed',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
      },
    ]);

    expect(merged[0].status_text).toBe('Cancelled by guest');
  });

  it('keeps confirmed status ahead of stale pending/awaiting fragments', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const merged = __reservationScraperTestHooks.mergeReservations([
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Confirmed',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
      },
      {
        conf_code: 'HMABC123',
        guest_name: 'Ada Lovelace',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'Awaiting payment',
        listing_id: 'listing-1',
        listing_name: 'Lake House',
      },
    ]);

    expect(merged[0].status_text).toBe('Confirmed');
  });

  it('ignores nested JSON lookalikes without reservation corroboration', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const reservations = __reservationScraperTestHooks.collectJsonReservations({
      analyticsEvent: {
        confirmationCode: 'HMABC123',
        guestName: 'Ada Lovelace',
        checkIn: '2026-05-01',
        checkOut: '2026-05-04',
      },
    });

    expect(reservations).toEqual([]);
  });

  it('detects explicit empty-state page text', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const snapshot = {
      url: 'https://www.airbnb.com/hosting/reservations',
      title: 'Reservations',
      text: 'No upcoming reservations',
      anchors: [],
    } as Parameters<typeof __reservationScraperTestHooks.hasEmptyState>[0];

    expect(__reservationScraperTestHooks.hasEmptyState(snapshot)).toBe(true);
  });

  it('extracts a reservation from a DOM snapshot with reservation detail anchors', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const snapshot = {
      url: 'https://www.airbnb.com/hosting/reservations',
      title: 'Reservations',
      text: 'Reservations',
      anchors: [
        {
          href: 'https://www.airbnb.com/hosting/reservations/details/HMABC123',
          text: 'Grace Hopper',
          cardText: 'Grace Hopper confirmed 2026-05-01 2026-05-04 Lake House',
        },
      ],
    } as Parameters<typeof __reservationScraperTestHooks.reservationsFromDom>[0];

    expect(__reservationScraperTestHooks.reservationsFromDom(snapshot)).toEqual([
      expect.objectContaining({
        conf_code: 'HMABC123',
        guest_name: 'Grace Hopper',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
        status_text: 'confirmed',
      }),
    ]);
  });

  it('ignores broad reservation navigation links in DOM snapshots', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const snapshot = {
      url: 'https://www.airbnb.com/hosting/reservations/all',
      title: 'Reservations',
      text: 'Reservations',
      anchors: [
        {
          href: 'https://www.airbnb.com/hosting/reservations',
          text: 'Reservations',
          cardText: 'Reservations May 1 - 4 Confirmed',
        },
      ],
    } as Parameters<typeof __reservationScraperTestHooks.reservationsFromDom>[0];

    expect(__reservationScraperTestHooks.reservationsFromDom(snapshot, 2026)).toEqual([]);
  });

  it('extracts common Airbnb month-name DOM date ranges without corrupting guest names', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const snapshot = {
      url: 'https://www.airbnb.com/hosting/reservations',
      title: 'Reservations',
      text: 'Reservations',
      anchors: [
        {
          href: 'https://www.airbnb.com/hosting/reservations/details/HMABC123',
          text: 'Grace Hopper May 1 - 4 Confirmed Lake House',
          cardText: 'Grace Hopper May 1 - 4 Confirmed Lake House',
        },
      ],
    } as Parameters<typeof __reservationScraperTestHooks.reservationsFromDom>[0];

    expect(__reservationScraperTestHooks.reservationsFromDom(snapshot, 2026)).toEqual([
      expect.objectContaining({
        conf_code: 'HMABC123',
        guest_name: 'Grace Hopper',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
      }),
    ]);
  });

  it('does not drop guests whose names look like month names', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const snapshot = {
      url: 'https://www.airbnb.com/hosting/reservations',
      title: 'Reservations',
      text: 'Reservations',
      anchors: [
        {
          href: 'https://www.airbnb.com/hosting/reservations/details/HMABC123',
          text: 'May Smith',
          cardText: 'May Smith May 1 - 4 Confirmed Lake House',
        },
      ],
    } as Parameters<typeof __reservationScraperTestHooks.reservationsFromDom>[0];

    expect(__reservationScraperTestHooks.reservationsFromDom(snapshot, 2026)).toEqual([
      expect.objectContaining({
        conf_code: 'HMABC123',
        guest_name: 'May Smith',
        check_in: '2026-05-01',
        check_out: '2026-05-04',
      }),
    ]);
  });

  it('does not inflate explicit cross-year DOM ranges', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const snapshot = {
      url: 'https://www.airbnb.com/hosting/reservations',
      title: 'Reservations',
      text: 'Reservations',
      anchors: [
        {
          href: 'https://www.airbnb.com/hosting/reservations/details/HMABC123',
          text: 'Grace Hopper',
          cardText: 'Grace Hopper Dec 30, 2025 - Jan 2, 2026 Confirmed Lake House',
        },
      ],
    } as Parameters<typeof __reservationScraperTestHooks.reservationsFromDom>[0];

    expect(__reservationScraperTestHooks.reservationsFromDom(snapshot, 2025)).toEqual([
      expect.objectContaining({
        check_in: '2025-12-30',
        check_out: '2026-01-02',
      }),
    ]);
  });

  it('infers the prior start year when only a cross-year end year is visible', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');
    const snapshot = {
      url: 'https://www.airbnb.com/hosting/reservations',
      title: 'Reservations',
      text: 'Reservations',
      anchors: [
        {
          href: 'https://www.airbnb.com/hosting/reservations/details/HMABC123',
          text: 'Grace Hopper',
          cardText: 'Grace Hopper Dec 30 - Jan 2, 2027 Confirmed Lake House',
        },
      ],
    } as Parameters<typeof __reservationScraperTestHooks.reservationsFromDom>[0];

    expect(__reservationScraperTestHooks.reservationsFromDom(snapshot, 2026)).toEqual([
      expect.objectContaining({
        check_in: '2026-12-30',
        check_out: '2027-01-02',
      }),
    ]);
  });

  it('normalizes display dates and currency strings without timezone drift', async () => {
    const { __reservationScraperTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-reservations')
    >('../src/playwright/scrape-reservations');

    expect(__reservationScraperTestHooks.normalizeDate('May 1, 2026')).toBe('2026-05-01');
    expect(__reservationScraperTestHooks.normalizeDate('05/01/2026')).toBe('2026-05-01');
    expect(__reservationScraperTestHooks.numberish('$1,234.50')).toBe(1234.5);
    expect(__reservationScraperTestHooks.numberish('€ 1.200,50')).toBe(1200.5);
  });
});
