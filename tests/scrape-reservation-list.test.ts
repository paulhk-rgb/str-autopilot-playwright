/**
 * /scrape-reservation-list endpoint integration tests.
 *
 * Covers handler-level concerns (validation, host_id binding, error
 * propagation, response shape). HMAC verification is tested in hmac.test.ts
 * and is a middleware concern — bypassed here so we can exercise the handler
 * directly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/scrape-reservations', () => ({
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

function buildReqRes(body: unknown): {
  req: Request;
  res: Response;
  jsonSpy: ReturnType<typeof vi.fn>;
  statusSpy: ReturnType<typeof vi.fn>;
  setHeaderSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn();
  const statusSpy = vi.fn().mockImplementation(() => ({ json: jsonSpy }));
  const setHeaderSpy = vi.fn();
  const res = {
    status: statusSpy,
    json: jsonSpy,
    setHeader: setHeaderSpy,
  } as unknown as Response;
  const req = { body } as Request;
  return { req, res, jsonSpy, statusSpy, setHeaderSpy };
}

beforeEach(() => {
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.readAirbnbSessionStrict).mockReset();
  vi.mocked(scraperModule.scrapeReservationList).mockReset();
  // Default to ready epoch; tests that exercise the rotation guard reset/bump as needed.
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();
});

describe('scrapeReservationListHandler', () => {
  it('returns 400 when body is missing required host_id', async () => {
    const { req, res, jsonSpy, statusSpy } = buildReqRes({ mode: 'incremental' });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_body' });
  });

  it('returns 400 on unknown mode value', async () => {
    const { req, res, statusSpy } = buildReqRes({ host_id: HOST_ID, mode: 'turbo' });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('returns 400 when since is non-string', async () => {
    const { req, res, statusSpy } = buildReqRes({ host_id: HOST_ID, since: 12345 });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('returns 400 when since is not a parsable timestamp', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      since: 'yesterday',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_body' });
  });

  it('returns 400 when since uses space separator instead of T', async () => {
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      since: '2026-04-28 10:30:00',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('returns 400 when since is locale-format date', async () => {
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      since: '04/28/2026',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('returns 400 when since is date-only (contract requires date-time)', async () => {
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      since: '2026-04-01',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('returns 400 when since is an invalid calendar date that Date.parse silently corrects (2026-02-31Z)', async () => {
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      since: '2026-02-31T00:00:00Z',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('returns 400 when since is an invalid month (2026-13-01Z)', async () => {
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      since: '2026-13-01T00:00:00Z',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it.each([
    ['canonical-Z-millis', '2026-04-01T00:00:00.000Z'],
    ['Z-no-millis', '2026-04-01T00:00:00Z'],
    ['plus-offset-no-millis', '2026-04-01T00:00:00+00:00'],
    ['minus-offset-no-millis', '2026-04-01T05:00:00-05:00'],
    ['Z-microseconds', '2026-04-01T00:00:00.123456Z'],
  ])('accepts %s ISO8601 since: %s', async (_name, since) => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue({
      reservations: [],
      scrapedAt: '2026-04-28T00:00:00.000Z',
      accountEmail: '',
    });
    const { req, res, statusSpy } = buildReqRes({ host_id: HOST_ID, since });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it('accepts valid ISO8601 since', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue({
      reservations: [],
      scrapedAt: '2026-04-28T00:00:00.000Z',
      accountEmail: '',
    });
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      since: '2026-04-01T00:00:00.000Z',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it('returns 403 when host_id does not match machine HOST_ID', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: '99999999-9999-9999-9999-999999999999',
      mode: 'incremental',
    });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'host_id_mismatch' });
  });

  it('returns 500 with browser_failed when getBrowserContext throws', async () => {
    vi.mocked(browserModule.getBrowserContext).mockRejectedValue(new Error('chromium dead'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'browser_failed', message: 'chromium dead' }),
    );
  });

  it('returns 409 auth_epoch_not_ready when /inject-cookies has not completed', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    _resetAuthEpochForTesting();
    beginCookieInject(); // cookies in flight; ready=false
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_not_ready' });
    expect(scraperModule.scrapeReservationList).not.toHaveBeenCalled();
  });

  it('returns 409 auth_epoch_changed when cookies rotate mid-scrape', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockImplementation(async () => {
      // Simulate cookie rotation while scrape is in flight.
      beginCookieInject();
      return { reservations: [], scrapedAt: '2026-04-28T00:00:00.000Z', accountEmail: '' };
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
  });

  it('returns 401 invalid_cookies when no Airbnb session present', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(scraperModule.scrapeReservationList).not.toHaveBeenCalled();
  });

  it('returns 409 auth_epoch_changed when scraper throws AND epoch rotated mid-scrape', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockImplementation(async () => {
      // Simulate Playwright `Target closed` while a concurrent /inject-cookies bumps the epoch.
      beginCookieInject();
      throw new Error('Target closed');
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
  });

  it('returns 409 auth_epoch_changed when hasAirbnbSession throws AND epoch rotated', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockImplementation(async () => {
      beginCookieInject();
      throw new Error('cookie store closed');
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
  });

  it('returns 409 auth_epoch_changed when hasAirbnbSession returns false because of mid-rotation', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockImplementation(async () => {
      beginCookieInject();
      return false;
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_changed' });
  });

  it('returns 500 with scrape_failed when scraper throws', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockRejectedValue(new Error('dom not found'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'scrape_failed', message: 'dom not found' }),
    );
  });

  it('returns 200 with body matching Issue #45 contract on real-scraper happy path (no X-Stub header)', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue({
      reservations: [
        {
          conf_code: 'HMABC123',
          guest_name: 'Test Guest',
          check_in: '2026-05-01',
          check_out: '2026-05-04',
          status: 'accepted',
        },
      ],
      scrapedAt: '2026-04-28T00:00:00.000Z',
      accountEmail: 'host@example.com',
    });

    const { req, res, statusSpy, jsonSpy, setHeaderSpy } = buildReqRes({
      host_id: HOST_ID,
      mode: 'incremental',
      since: '2026-04-01T00:00:00.000Z',
    });
    await scrapeReservationListHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({
      reservations: [
        {
          conf_code: 'HMABC123',
          guest_name: 'Test Guest',
          check_in: '2026-05-01',
          check_out: '2026-05-04',
          status: 'accepted',
        },
      ],
      scraped_at: '2026-04-28T00:00:00.000Z',
      account_email: 'host@example.com',
    });
    expect(setHeaderSpy).not.toHaveBeenCalledWith('X-Stub', expect.anything());
  });

  it('sets X-Stub: true header when stub scraper sets the flag (body still matches contract)', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue({
      reservations: [],
      scrapedAt: '2026-04-28T00:00:00.000Z',
      accountEmail: '',
      stub: true,
    });
    const { req, res, statusSpy, jsonSpy, setHeaderSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(setHeaderSpy).toHaveBeenCalledWith('X-Stub', 'true');
    expect(jsonSpy).toHaveBeenCalledWith({
      reservations: [],
      scraped_at: '2026-04-28T00:00:00.000Z',
      account_email: '',
    });
  });

  it('returns 500 with session_check_failed when hasAirbnbSession throws', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockRejectedValue(new Error('cookie store dead'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'session_check_failed', message: 'cookie store dead' }),
    );
  });

  it('defaults mode to incremental when omitted', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue({
      reservations: [],
      scrapedAt: '2026-04-28T00:00:00.000Z',
      accountEmail: '',
    });
    const { req, res, statusSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeReservationList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'incremental' }),
    );
  });

  it('stub scraper returns empty reservations + populated scraped_at + stub flag', async () => {
    const { scrapeReservationList } = await vi.importActual<typeof scraperModule>(
      '../src/playwright/scrape-reservations',
    );
    const result = await scrapeReservationList({} as never, { mode: 'incremental' });
    expect(result.reservations).toEqual([]);
    expect(result.accountEmail).toBe('');
    expect(result.stub).toBe(true);
    expect(() => new Date(result.scrapedAt).toISOString()).not.toThrow();
    expect(new Date(result.scrapedAt).toISOString()).toBe(result.scrapedAt);
  });
});
