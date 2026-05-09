import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  ensureSpaListenerOnPage: vi.fn(),
  getBrowserContext: vi.fn(),
  markAirbnbRequest: vi.fn(),
}));

vi.mock('../src/playwright/scrape-inbox', () => ({
  scrapeInbox: vi.fn(),
}));

vi.mock('../src/lib/callback', () => ({
  postCallback: vi.fn(),
}));

import { syncHandler } from '../src/endpoints/sync';
import * as browserModule from '../src/playwright/browser';
import * as scraperModule from '../src/playwright/scrape-inbox';
import * as callbackModule from '../src/lib/callback';
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
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.markAirbnbRequest).mockReset();
  vi.mocked(scraperModule.scrapeInbox).mockReset();
  vi.mocked(callbackModule.postCallback).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(callbackModule.postCallback).mockResolvedValue({
    ok: true,
    status: 200,
    bodyText: '{}',
  });
});

describe('syncHandler single-flight and budget semantics', () => {
  it('rejects a concurrent sync without emitting callback batches', async () => {
    let finishScrape: ((value: { messages: never[]; bookingsFound: number; errors: never[] }) => void) | null =
      null;
    vi.mocked(scraperModule.scrapeInbox).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishScrape = resolve;
        }),
    );

    const first = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    const firstPromise = syncHandler(env)(first.req, first.res);
    await vi.waitFor(() => expect(scraperModule.scrapeInbox).toHaveBeenCalledTimes(1));

    const second = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(env)(second.req, second.res);

    expect(second.statusSpy).toHaveBeenCalledWith(409);
    expect(second.jsonSpy).toHaveBeenCalledWith({
      messages_found: 0,
      bookings_found: 0,
      errors: ['sync_already_running'],
    });
    expect(callbackModule.postCallback).not.toHaveBeenCalled();

    finishScrape?.({ messages: [], bookingsFound: 0, errors: [] });
    await firstPromise;
    expect(first.statusSpy).toHaveBeenCalledWith(200);
    expect(callbackModule.postCallback).toHaveBeenCalledTimes(1);
  });

  it('releases the single-flight lock when browser startup fails', async () => {
    vi.mocked(browserModule.getBrowserContext).mockRejectedValueOnce(new Error('chromium dead'));
    const failed = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(env)(failed.req, failed.res);
    expect(failed.statusSpy).toHaveBeenCalledWith(500);

    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: [],
    });
    const next = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(env)(next.req, next.res);

    expect(next.statusSpy).toHaveBeenCalledWith(200);
    expect(callbackModule.postCallback).toHaveBeenCalledTimes(1);
  });

  it('does not emit an empty completion callback when no messages were read because budget expired', async () => {
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: [
        'sync_time_budget_exhausted:mode=incremental:phase=inbox:threads_read=0:threads_total=0:elapsed_ms=40000',
      ],
    });

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(callbackModule.postCallback).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 0,
        errors: expect.arrayContaining([expect.stringContaining('sync_time_budget_exhausted')]),
      }),
    );
  });
});
