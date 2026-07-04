import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

const watermarkMocks = vi.hoisted(() => ({
  load: vi.fn(),
  merge: vi.fn(),
  save: vi.fn(),
}));

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

vi.mock('../src/playwright/api-reader-cycle', () => ({
  runApiReaderCycle: vi.fn(),
}));

vi.mock('../src/playwright/watermark-store', () => ({
  WatermarkStore: vi.fn().mockImplementation(() => ({
    load: watermarkMocks.load,
    merge: watermarkMocks.merge,
    save: watermarkMocks.save,
  })),
}));

import { syncHandler } from '../src/endpoints/sync';
import * as browserModule from '../src/playwright/browser';
import * as scraperModule from '../src/playwright/scrape-inbox';
import * as callbackModule from '../src/lib/callback';
import * as apiCycleModule from '../src/playwright/api-reader-cycle';
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
  vi.mocked(browserModule.ensureSpaListenerOnPage).mockReset();
  vi.mocked(browserModule.markAirbnbRequest).mockReset();
  vi.mocked(scraperModule.scrapeInbox).mockReset();
  vi.mocked(callbackModule.postCallback).mockReset();
  vi.mocked(apiCycleModule.runApiReaderCycle).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(callbackModule.postCallback).mockResolvedValue({
    ok: true,
    status: 200,
    bodyText: '{}',
  });
  watermarkMocks.load.mockReset();
  watermarkMocks.load.mockReturnValue({});
  watermarkMocks.merge.mockReset();
  watermarkMocks.merge.mockImplementation((prev, advances) => ({ ...prev, ...advances }));
  watermarkMocks.save.mockReset();
});

describe('syncHandler single-flight and budget semantics', () => {
  it('rejects malformed target_thread_ids without starting the browser', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      mode: 'incremental',
      target_thread_ids: ['2470285483', '2470285483'],
    });

    await syncHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_body' });
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
  });

  it('passes target_thread_ids to the UI scraper', async () => {
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: [],
    });

    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      mode: 'incremental',
      target_thread_ids: ['2470285483'],
    });
    await syncHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeInbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetThreadIds: ['2470285483'] }),
    );
  });

  it('uses the API reader as authority for targeted threads when available', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-target-api',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: true,
      apiMessages: [
        {
          airbnb_message_id: 'airbnb-30308576054',
          content: 'target message',
          sender: 'guest',
          timestamp: '2026-04-10T01:39:18.484Z',
          conversation_airbnb_id: '2470285483',
          guest_name: 'Soonbong Lee',
          listing_name: 'Listing',
        },
        {
          airbnb_message_id: 'airbnb-30308567188',
          content: 'target host reply',
          sender: 'host',
          timestamp: '2026-04-10T01:38:13.119Z',
          conversation_airbnb_id: '2470285483',
          guest_name: 'Soonbong Lee',
          listing_name: 'Listing',
        },
      ],
      perThread: [],
      totalApiMessagesEmitted: 2,
      watermarkAdvancesApplied: { '2470285483': 1775785158484 },
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      mode: 'incremental',
      target_thread_ids: ['2470285483'],
    });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeInbox).not.toHaveBeenCalled();
    expect(apiCycleModule.runApiReaderCycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetRawThreadIds: ['2470285483'], mode: 'api' }),
    );
    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          payload: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({ airbnb_message_id: 'airbnb-30308576054', sender: 'guest' }),
              expect.objectContaining({ airbnb_message_id: 'airbnb-30308567188', sender: 'host' }),
            ]),
            has_more: false,
          }),
        }),
      }),
    );
    expect(watermarkMocks.save).toHaveBeenCalledWith({ '2470285483': 1775785158484 });
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 2,
        errors: [],
        apiDiag: expect.objectContaining({
          fallback: 'target_thread_api_authority',
          uiMessageCount: 0,
          uiErrors: [],
          messagesEmitted: 2,
          error: null,
        }),
      }),
    );
  });

  it('recovers a targeted sync via the UI reader when API authority fails', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-target-api-fail',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: false,
      apiSkipReason: 'all_target_threads_failed',
      apiMessages: [],
      perThread: [],
      totalApiMessagesEmitted: 0,
      watermarkAdvancesApplied: {},
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [
        {
          airbnb_message_id: 'airbnb-30308576054',
          content: 'ui recovered message',
          sender: 'guest',
          timestamp: '2026-04-10T01:39:18.484Z',
          conversation_airbnb_id: '2470285483',
          guest_name: 'Soonbong Lee',
          listing_name: 'Listing',
        },
      ],
      bookingsFound: 0,
      errors: [],
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      mode: 'incremental',
      target_thread_ids: ['2470285483'],
    });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeInbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetThreadIds: ['2470285483'] }),
    );
    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          payload: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({ airbnb_message_id: 'airbnb-30308576054' }),
            ]),
            has_more: false,
          }),
        }),
      }),
    );
    expect(watermarkMocks.save).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 1,
        errors: [],
        apiDiag: expect.objectContaining({
          fallback: 'target_thread_ui_recovery',
          error: 'all_target_threads_failed',
          uiMessageCount: 1,
          messagesEmitted: 1,
        }),
      }),
    );
  });

  it('does not emit an empty completion callback when targeted API AND UI recovery both fail', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-target-api-fail',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: false,
      apiSkipReason: 'inbox_failed',
      inboxFailureReason: 'http_error',
      apiMessages: [],
      perThread: [],
      totalApiMessagesEmitted: 0,
      watermarkAdvancesApplied: {},
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: ['thread_2470285483_failed: thread_message_list_unavailable'],
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      mode: 'incremental',
      target_thread_ids: ['2470285483'],
    });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(callbackModule.postCallback).not.toHaveBeenCalled();
    expect(watermarkMocks.save).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 0,
        errors: [
          'thread_2470285483_failed: thread_message_list_unavailable',
          'target_api_failed: inbox_failed',
        ],
        apiDiag: expect.objectContaining({
          fallback: 'target_thread_ui_recovery',
          error: 'inbox_failed',
        }),
      }),
    );
  });

  it('passes the env-pinned client version fallback into the API reader cycle', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-cv',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: true,
      apiMessages: [],
      perThread: [],
      totalApiMessagesEmitted: 0,
      watermarkAdvancesApplied: {},
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'v-pinned',
      elapsedMs: 5,
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
      AIRBNB_API_CLIENT_VERSION: 'v-pinned',
    };

    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      mode: 'incremental',
      target_thread_ids: ['2470285483'],
    });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientVersionFallback: 'v-pinned' }),
    );
  });

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

  it('uses API as the emitter when UI reads zero messages from a recoverable thread DOM failure', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: ['thread_2515861751_failed: thread_message_list_unavailable'],
    });
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-api-fallback',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: true,
      apiMessages: [
        {
          airbnb_message_id: 'airbnb-100',
          content: 'hello',
          sender: 'guest',
          timestamp: '2026-05-09T12:00:00.000Z',
          conversation_airbnb_id: '2515861751',
          guest_name: 'Guest',
          listing_name: 'Listing',
        },
      ],
      perThread: [],
      totalApiMessagesEmitted: 1,
      watermarkAdvancesApplied: { '2515861751': 1778328000000 },
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          payload: expect.objectContaining({
            messages: [expect.objectContaining({ airbnb_message_id: 'airbnb-100' })],
            has_more: false,
          }),
        }),
      }),
    );
    expect(watermarkMocks.save).toHaveBeenCalledWith({ '2515861751': 1778328000000 });
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 1,
        errors: [],
        apiDiag: expect.objectContaining({
          fallback: 'ui_zero_message_recovery',
          messagesEmitted: 1,
          error: null,
        }),
      }),
    );
  });

  it('uses API fallback for a recoverable inbox-list DOM failure', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: ['inbox_list_failed: inbox_list_unavailable:url=https://www.airbnb.com/hosting/messages'],
    });
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-api-fallback-inbox',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: true,
      apiMessages: [],
      perThread: [],
      totalApiMessagesEmitted: 0,
      watermarkAdvancesApplied: {},
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 0,
        errors: [],
        apiDiag: expect.objectContaining({
          fallback: 'ui_zero_message_recovery',
          messagesEmitted: 0,
          error: null,
        }),
      }),
    );
  });

  it('uses API fallback for incremental zero-message budget exhaustion', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: [
        'sync_time_budget_exhausted:mode=incremental:phase=thread_loop:threads_read=0:threads_total=10:elapsed_ms=40000',
      ],
    });
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-api-fallback-budget',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: true,
      apiMessages: [
        {
          airbnb_message_id: 'airbnb-101',
          content: 'budget recovered',
          sender: 'guest',
          timestamp: '2026-05-09T12:05:00.000Z',
          conversation_airbnb_id: '2515861751',
          guest_name: 'Guest',
          listing_name: 'Listing',
        },
      ],
      perThread: [],
      totalApiMessagesEmitted: 1,
      watermarkAdvancesApplied: {},
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          payload: expect.objectContaining({
            messages: [expect.objectContaining({ airbnb_message_id: 'airbnb-101' })],
          }),
        }),
      }),
    );
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 1,
        errors: [],
        apiDiag: expect.objectContaining({
          fallback: 'ui_zero_message_recovery',
          messagesEmitted: 1,
          error: null,
        }),
      }),
    );
  });

  it('does not hide UI errors when fallback is eligible but API credentials are absent', async () => {
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: ['thread_2515861751_failed: thread_message_list_unavailable'],
    });

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 0,
        errors: ['thread_2515861751_failed: thread_message_list_unavailable'],
      }),
    );
  });

  it('uses API fallback for incremental partial UI budget exhaustion without dropping UI-only rows', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [
        {
          airbnb_message_id: 'ui-1',
          content: 'already captured',
          sender: 'guest',
          timestamp: '2026-05-09T12:00:00.000Z',
          conversation_airbnb_id: 'thread-1',
          guest_name: 'Guest',
          listing_name: 'Listing',
        },
      ],
      bookingsFound: 0,
      errors: [
        'sync_time_budget_exhausted:mode=incremental:phase=thread_loop:threads_read=1:threads_total=10:elapsed_ms=40000',
      ],
    });
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-api-fallback-partial-budget',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: true,
      apiMessages: [
        {
          airbnb_message_id: 'airbnb-102',
          content: 'api recovered',
          sender: 'guest',
          timestamp: '2026-05-09T12:05:00.000Z',
          conversation_airbnb_id: 'thread-1',
          guest_name: 'Guest',
          listing_name: 'Listing',
        },
      ],
      perThread: [],
      totalApiMessagesEmitted: 1,
      watermarkAdvancesApplied: { 'thread-1': 1778328300000 },
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          payload: expect.objectContaining({
            messages: [
              expect.objectContaining({ airbnb_message_id: 'airbnb-102' }),
              expect.objectContaining({ airbnb_message_id: 'ui-1' }),
            ],
          }),
        }),
      }),
    );
    expect(watermarkMocks.save).toHaveBeenCalledWith({ 'thread-1': 1778328300000 });
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 2,
        errors: [],
        apiDiag: expect.objectContaining({
          fallback: 'ui_partial_budget_recovery',
          uiMessageCount: 1,
          apiMessagesEmitted: 1,
          messagesEmitted: 2,
        }),
      }),
    );
  });

  it('does not API-fallback when the UI scraper emitted messages without a recoverable error', async () => {
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [
        {
          airbnb_message_id: 'ui-2',
          content: 'already captured',
          sender: 'guest',
          timestamp: '2026-05-09T12:00:00.000Z',
          conversation_airbnb_id: 'thread-1',
          guest_name: 'Guest',
          listing_name: 'Listing',
        },
      ],
      bookingsFound: 0,
      errors: [],
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).not.toHaveBeenCalled();
    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          payload: expect.objectContaining({
            messages: [expect.objectContaining({ airbnb_message_id: 'ui-2' })],
          }),
        }),
      }),
    );
  });

  it('does not commit API fallback watermarks when callback delivery fails', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: ['thread_2515861751_failed: thread_message_list_unavailable'],
    });
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-api-fallback-callback-fail',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: true,
      apiMessages: [
        {
          airbnb_message_id: 'airbnb-100',
          content: 'hello',
          sender: 'guest',
          timestamp: '2026-05-09T12:00:00.000Z',
          conversation_airbnb_id: '2515861751',
          guest_name: 'Guest',
          listing_name: 'Listing',
        },
      ],
      perThread: [],
      totalApiMessagesEmitted: 1,
      watermarkAdvancesApplied: { '2515861751': 1778328000000 },
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });
    vi.mocked(callbackModule.postCallback).mockResolvedValueOnce({
      ok: false,
      status: 500,
      bodyText: 'nope',
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(watermarkMocks.save).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 1,
        errors: ['batch_1_status_500'],
      }),
    );
  });

  it('keeps the original UI error visible when the API fallback also fails', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValueOnce({
      pages: () => [{}],
    } as never);
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: ['thread_2515861751_failed: thread_message_list_unavailable'],
    });
    vi.mocked(apiCycleModule.runApiReaderCycle).mockResolvedValueOnce({
      cycleId: 'cycle-api-fallback-failed',
      cycleStartAuthEpoch: 1,
      cycleEndAuthEpoch: 1,
      authEpochAborted: false,
      mode: 'api',
      ok: false,
      apiSkipReason: 'inbox_failed',
      inboxFailureReason: 'http_error',
      apiMessages: [],
      perThread: [],
      totalApiMessagesEmitted: 0,
      watermarkAdvancesApplied: {},
      inboxHashUsed: 'h1',
      threadHashUsed: 'h2',
      clientVersionUsed: 'client',
      elapsedMs: 25,
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy, jsonSpy } = buildReqRes({ host_id: HOST_ID, mode: 'incremental' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(callbackModule.postCallback).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages_found: 0,
        errors: [
          'thread_2515861751_failed: thread_message_list_unavailable',
          'api_fallback_failed: inbox_failed',
        ],
      }),
    );
  });

  it('does not add API work after an initial sync exhausts the full UI time budget', async () => {
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: [
        'sync_time_budget_exhausted:mode=initial:phase=thread_loop:threads_read=0:threads_total=30:elapsed_ms=180000',
      ],
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy } = buildReqRes({ host_id: HOST_ID, mode: 'initial' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).not.toHaveBeenCalled();
    expect(callbackModule.postCallback).not.toHaveBeenCalled();
  });

  it('does not add API work after initial budget exhaustion even with earlier DOM errors', async () => {
    vi.mocked(scraperModule.scrapeInbox).mockResolvedValueOnce({
      messages: [],
      bookingsFound: 0,
      errors: [
        'thread_2515861751_failed: thread_message_list_unavailable',
        'sync_time_budget_exhausted:mode=initial:phase=thread_loop:threads_read=0:threads_total=30:elapsed_ms=180000',
      ],
    });

    const envWithApi: MachineEnv = {
      ...env,
      AIRBNB_API_USER_ID: '50758264',
      AIRBNB_API_GLOBAL_USER_ID: 'Vmlld2VyOjUwNzU4MjY0',
    };

    const { req, res, statusSpy } = buildReqRes({ host_id: HOST_ID, mode: 'initial' });
    await syncHandler(envWithApi)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(apiCycleModule.runApiReaderCycle).not.toHaveBeenCalled();
    expect(callbackModule.postCallback).not.toHaveBeenCalled();
  });
});
