import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/send-message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright/send-message')>();
  return {
    ...actual,
    sendAirbnbMessage: vi.fn(),
  };
});

vi.mock('../src/lib/callback', () => ({
  postCallback: vi.fn(),
}));

import { sendMessageHandler, __sendMessageEndpointTestHooks } from '../src/endpoints/send-message';
import * as browserModule from '../src/playwright/browser';
import * as senderModule from '../src/playwright/send-message';
import * as callbackModule from '../src/lib/callback';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';
import { __resetSingleFlightForTesting } from '../src/lib/single-flight';

const HOST_ID = '11111111-2222-3333-4444-555555555555';
const MESSAGE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    host_id: HOST_ID,
    message_id: MESSAGE_ID,
    conversation_airbnb_id: '2470285483',
    guest_name: 'Olga Sapir',
    message: 'Thanks for staying with us.',
    check_in: '2026-04-15',
    check_out: '2026-05-06',
    confirmation_code: 'HM3ZXPMNZC',
    property_name: 'One Bedroom Private Unit .3 Miles from Commons',
    message_body_hash: 'a'.repeat(64),
    dispatch_attempt_key: `${MESSAGE_ID}:2470285483:${'a'.repeat(64)}`,
    ...overrides,
  };
}

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

beforeEach(async () => {
  __resetSingleFlightForTesting();
  await __sendMessageEndpointTestHooks.resetSendLedgerForTesting(env.PROFILE_DIR);
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.readAirbnbSessionStrict).mockReset();
  vi.mocked(senderModule.sendAirbnbMessage).mockReset();
  vi.mocked(callbackModule.postCallback).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
  vi.mocked(senderModule.sendAirbnbMessage).mockResolvedValue({ status: 'confirmed' });
  vi.mocked(callbackModule.postCallback).mockResolvedValue({
    ok: true,
    status: 200,
    bodyText: '{}',
  });
});

describe('send-message endpoint guards', () => {
  it('rejects malformed and scenario bodies before browser work', async () => {
    expect(
      __sendMessageEndpointTestHooks.isValidBody(validBody({ message: 'HMSCEN666EPC test reservation' })),
    ).toBe(false);

    const { req, res, statusSpy, jsonSpy } = buildReqRes(
      validBody({ message: 'HMSCEN666EPC test reservation' }),
    );
    await sendMessageHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_body' });
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
    expect(senderModule.sendAirbnbMessage).not.toHaveBeenCalled();
  });

  it('rejects host mismatch before browser work', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes(
      validBody({ host_id: '22222222-2222-3333-4444-555555555555' }),
    );
    await sendMessageHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'host_id_mismatch' });
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
  });

  it('returns busy without browser work when another send is in flight', async () => {
    let finishSend: ((value: { status: 'confirmed' }) => void) | null = null;
    vi.mocked(senderModule.sendAirbnbMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSend = resolve;
        }),
    );

    const first = buildReqRes(validBody());
    const firstPromise = sendMessageHandler(env)(first.req, first.res);
    await vi.waitFor(() => expect(senderModule.sendAirbnbMessage).toHaveBeenCalledTimes(1));

    const second = buildReqRes(validBody({ message_id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    await sendMessageHandler(env)(second.req, second.res);

    expect(second.statusSpy).toHaveBeenCalledWith(409);
    expect(second.jsonSpy).toHaveBeenCalledWith({ error: 'send_already_running' });
    expect(senderModule.sendAirbnbMessage).toHaveBeenCalledTimes(1);

    finishSend?.({ status: 'confirmed' });
    await firstPromise;
  });

  it('checks session before sending and returns invalid_cookies without callback', async () => {
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValueOnce(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody());

    await sendMessageHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(senderModule.sendAirbnbMessage).not.toHaveBeenCalled();
    expect(callbackModule.postCallback).not.toHaveBeenCalled();
  });

  it('sends confirmed callback only after browser confirmation', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody());

    await sendMessageHandler(env)(req, res);

    expect(senderModule.sendAirbnbMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        conversation_airbnb_id: '2470285483',
        guest_name: 'Olga Sapir',
        message: 'Thanks for staying with us.',
      }),
    );
    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          action: 'send_result',
          message_id: MESSAGE_ID,
          status: 'confirmed',
        }),
      }),
    );
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true, status: 'confirmed' });
  });

  it('marks confirmed callback failure as non-retryable browser success', async () => {
    vi.mocked(callbackModule.postCallback).mockRejectedValueOnce(new Error('callback down'));
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody());

    await sendMessageHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(202);
    expect(jsonSpy).toHaveBeenCalledWith({
      ok: true,
      status: 'callback_failed_after_send',
      do_not_retry_browser_send: true,
    });
  });

  it('retries only the callback after a confirmed send callback failure', async () => {
    vi.mocked(callbackModule.postCallback)
      .mockRejectedValueOnce(new Error('callback down'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        bodyText: '{}',
      });

    const first = buildReqRes(validBody());
    await sendMessageHandler(env)(first.req, first.res);

    const second = buildReqRes(validBody());
    await sendMessageHandler(env)(second.req, second.res);

    expect(senderModule.sendAirbnbMessage).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).toHaveBeenCalledTimes(2);
    expect(second.statusSpy).toHaveBeenCalledWith(200);
    expect(second.jsonSpy).toHaveBeenCalledWith({
      ok: true,
      status: 'confirmed',
      duplicate_suppressed: true,
    });
  });

  it('does not send a failed callback after an ambiguous post-click submit', async () => {
    vi.mocked(senderModule.sendAirbnbMessage).mockResolvedValueOnce({
      status: 'submitted_unconfirmed',
      error: 'verification_failed_after_click',
      clicked_send: true,
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody());

    await sendMessageHandler(env)(req, res);

    expect(callbackModule.postCallback).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(202);
    expect(jsonSpy).toHaveBeenCalledWith({
      ok: true,
      status: 'submitted_unconfirmed',
      error: 'verification_failed_after_click',
      do_not_retry_browser_send: true,
    });
  });

  it('suppresses duplicate browser sends after an ambiguous post-click submit', async () => {
    vi.mocked(senderModule.sendAirbnbMessage).mockResolvedValueOnce({
      status: 'submitted_unconfirmed',
      error: 'verification_failed_after_click',
      clicked_send: true,
    });
    const first = buildReqRes(validBody());
    await sendMessageHandler(env)(first.req, first.res);

    const second = buildReqRes(validBody());
    await sendMessageHandler(env)(second.req, second.res);

    expect(senderModule.sendAirbnbMessage).toHaveBeenCalledTimes(1);
    expect(callbackModule.postCallback).not.toHaveBeenCalled();
    expect(second.statusSpy).toHaveBeenCalledWith(202);
    expect(second.jsonSpy).toHaveBeenCalledWith({
      ok: true,
      status: 'submitted_unconfirmed',
      error: 'verification_failed_after_click',
      duplicate_suppressed: true,
      do_not_retry_browser_send: true,
    });
  });

  it('suppresses duplicate browser sends from the disk ledger after a worker restart', async () => {
    vi.mocked(senderModule.sendAirbnbMessage).mockResolvedValueOnce({
      status: 'submitted_unconfirmed',
      error: 'verification_failed_after_click',
      clicked_send: true,
    });
    const first = buildReqRes(validBody());
    await sendMessageHandler(env)(first.req, first.res);

    __sendMessageEndpointTestHooks.clearSendLedgerMemoryForTesting();

    const second = buildReqRes(validBody());
    await sendMessageHandler(env)(second.req, second.res);

    expect(senderModule.sendAirbnbMessage).toHaveBeenCalledTimes(1);
    expect(second.statusSpy).toHaveBeenCalledWith(202);
    expect(second.jsonSpy).toHaveBeenCalledWith({
      ok: true,
      status: 'submitted_unconfirmed',
      error: 'verification_failed_after_click',
      duplicate_suppressed: true,
      do_not_retry_browser_send: true,
    });
  });

  it('does not shadow a post-click browser result with an auth-epoch 503', async () => {
    vi.mocked(senderModule.sendAirbnbMessage).mockImplementationOnce(async () => {
      beginCookieInject();
      return { status: 'confirmed' };
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody());

    await sendMessageHandler(env)(req, res);

    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          status: 'confirmed',
        }),
      }),
    );
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true, status: 'confirmed' });
  });

  it('posts a failed callback when browser rejects before clicking send', async () => {
    vi.mocked(senderModule.sendAirbnbMessage).mockResolvedValueOnce({
      status: 'failed',
      error: 'identity_mismatch',
      clicked_send: false,
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody());

    await sendMessageHandler(env)(req, res);

    expect(callbackModule.postCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          action: 'send_result',
          message_id: MESSAGE_ID,
          status: 'failed',
          error: 'identity_mismatch',
        }),
      }),
    );
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({
      ok: false,
      status: 'failed',
      error: 'identity_mismatch',
    });
  });

  it('fails closed during cookie rotation', async () => {
    _resetAuthEpochForTesting();
    beginCookieInject();
    const { req, res, statusSpy, jsonSpy } = buildReqRes(validBody());

    await sendMessageHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'auth_epoch_not_ready' });
    expect(senderModule.sendAirbnbMessage).not.toHaveBeenCalled();
  });
});

describe('send-message page identity helpers', () => {
  it('requires context evidence when only first name matches', async () => {
    const { __sendMessageTestHooks } = await vi.importActual<typeof import('../src/playwright/send-message')>(
      '../src/playwright/send-message',
    );

    const pageText = "Olga's trip Apr 15 - May 6 One Bedroom Private Unit .3 Miles from Commons";
    expect(
      __sendMessageTestHooks.canTrustMessageThread(
        {
          conversation_airbnb_id: '2470285483',
          guest_name: 'Olga Sapir',
          message: 'hello',
          check_in: '2026-04-15',
          check_out: '2026-05-06',
          property_name: 'One Bedroom Private Unit .3 Miles from Commons',
        },
        pageText,
      ),
    ).toBe(true);

    expect(
      __sendMessageTestHooks.canTrustMessageThread(
        {
          conversation_airbnb_id: '2470285483',
          guest_name: 'Olga Sapir',
          message: 'hello',
          property_name: 'One Bedroom Private Unit .3 Miles from Commons',
        },
        "Olga's trip Lake House",
      ),
    ).toBe(false);
  });

  it('requires context evidence for single-token guest names', async () => {
    const { __sendMessageTestHooks } = await vi.importActual<typeof import('../src/playwright/send-message')>(
      '../src/playwright/send-message',
    );

    expect(
      __sendMessageTestHooks.canTrustMessageThread(
        {
          conversation_airbnb_id: '2470285483',
          guest_name: 'Olga',
          message: 'hello',
          property_name: 'One Bedroom Private Unit .3 Miles from Commons',
        },
        "Olga's trip Lake House",
      ),
    ).toBe(false);

    expect(
      __sendMessageTestHooks.canTrustMessageThread(
        {
          conversation_airbnb_id: '2470285483',
          guest_name: 'Olga',
          message: 'hello',
          property_name: 'One Bedroom Private Unit .3 Miles from Commons',
        },
        "Olga's trip One Bedroom Private Unit .3 Miles from Commons",
      ),
    ).toBe(true);
  });

  it('matches zero-padded dates and symbol-only typed messages', async () => {
    const { __sendMessageTestHooks } = await vi.importActual<typeof import('../src/playwright/send-message')>(
      '../src/playwright/send-message',
    );

    expect(__sendMessageTestHooks.dateAppearsOnPage('2026-04-05', 'Arrives April 05')).toBe(true);
    expect(__sendMessageTestHooks.hasMeaningfulComposeText('🌍')).toBe(true);
    expect(__sendMessageTestHooks.composeTextMatchesMessage('🌍', '🌍')).toBe(true);
    expect(__sendMessageTestHooks.composeTextMatchesMessage('?!?', '?!?')).toBe(true);
  });

  it('uses the full normalized message as the read-back fingerprint', async () => {
    const { __sendMessageTestHooks } = await vi.importActual<typeof import('../src/playwright/send-message')>(
      '../src/playwright/send-message',
    );
    const longMessage = `${'Thanks for staying with us. '.repeat(8)}The unique closing sentence matters.`;

    expect(__sendMessageTestHooks.messageFingerprint(longMessage)).toContain('the unique closing sentence matters');
  });
});
