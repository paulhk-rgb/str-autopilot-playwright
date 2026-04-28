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
  hasAirbnbSession: vi.fn(),
}));

vi.mock('../src/playwright/scrape-reservations', () => ({
  scrapeReservationList: vi.fn(),
}));

import { scrapeReservationListHandler } from '../src/endpoints/scrape-reservation-list';
import * as browserModule from '../src/playwright/browser';
import * as scraperModule from '../src/playwright/scrape-reservations';

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

function buildReqRes(body: unknown): { req: Request; res: Response; jsonSpy: ReturnType<typeof vi.fn>; statusSpy: ReturnType<typeof vi.fn> } {
  const jsonSpy = vi.fn();
  const statusSpy = vi.fn().mockImplementation(() => ({ json: jsonSpy }));
  const res = { status: statusSpy, json: jsonSpy } as unknown as Response;
  const req = { body } as Request;
  return { req, res, jsonSpy, statusSpy };
}

beforeEach(() => {
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.hasAirbnbSession).mockReset();
  vi.mocked(scraperModule.scrapeReservationList).mockReset();
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

  it('accepts valid ISO8601 since', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.hasAirbnbSession).mockResolvedValue(true);
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

  it('returns 401 invalid_cookies when no Airbnb session present', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.hasAirbnbSession).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(scraperModule.scrapeReservationList).not.toHaveBeenCalled();
  });

  it('returns 500 with scrape_failed when scraper throws', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.hasAirbnbSession).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockRejectedValue(new Error('dom not found'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'scrape_failed', message: 'dom not found' }),
    );
  });

  it('returns 200 with reservations + scraped_at + account_email on happy path (real scraper, no _stub)', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.hasAirbnbSession).mockResolvedValue(true);
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

    const { req, res, statusSpy, jsonSpy } = buildReqRes({
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
    const sentBody = jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentBody._stub).toBeUndefined();
  });

  it('surfaces _stub: true when stub scraper sets the flag', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.hasAirbnbSession).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReservationList).mockResolvedValue({
      reservations: [],
      scrapedAt: '2026-04-28T00:00:00.000Z',
      accountEmail: '',
      stub: true,
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({
      reservations: [],
      scraped_at: '2026-04-28T00:00:00.000Z',
      account_email: '',
      _stub: true,
    });
  });

  it('returns 500 with session_check_failed when hasAirbnbSession throws', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.hasAirbnbSession).mockRejectedValue(new Error('cookie store dead'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID });
    await scrapeReservationListHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'session_check_failed', message: 'cookie store dead' }),
    );
  });

  it('defaults mode to incremental when omitted', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.hasAirbnbSession).mockResolvedValue(true);
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
