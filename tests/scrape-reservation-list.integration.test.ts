/**
 * /scrape-reservation-list HTTP integration test.
 *
 * Boots `buildApp` on a random port and verifies the route is mounted behind
 * the HMAC middleware (proves the security boundary, which the handler-level
 * tests in scrape-reservation-list.test.ts intentionally bypass).
 *
 * Covers:
 *   - Unauthenticated POST returns 401 (HMAC middleware rejects)
 *   - Tampered signature returns 401
 *   - Valid signature reaches the handler (mocked browser modules return 401
 *     invalid_cookies via the stub auth gate, proving middleware passed)
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn().mockResolvedValue({}),
  hasAirbnbSession: vi.fn().mockResolvedValue(false),
  readAirbnbSessionStrict: vi.fn().mockResolvedValue(false),
  closeBrowserContext: vi.fn().mockResolvedValue(undefined),
  markAirbnbRequest: vi.fn(),
  getLastAirbnbRequestAt: vi.fn().mockReturnValue(null),
  openPage: vi.fn(),
  getSpaListener: vi.fn(),
  ensureSpaListenerOnPage: vi.fn(),
}));
vi.mock('../src/playwright/scrape-reservations', () => ({
  scrapeReservationList: vi.fn(),
}));

import { buildApp } from '../src/server';
import {
  EMPTY_BODY_SHA256,
  sha256Hex,
  signHmac,
} from '../src/lib/hmac';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';
import type { MachineEnv } from '../src/lib/env';

const HMAC_SECRET = '7b2e2f1a0d6c4e6e89ab22c3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d';
const HOST_ID = '11111111-2222-3333-4444-555555555555';

const env: MachineEnv = {
  HMAC_SECRET,
  HOST_ID,
  CALLBACK_URL: 'http://localhost:9999/callback',
  PORT: 0,
  PROFILE_DIR: '/tmp/test-profile',
  INBOX_READER_MODE: 'ui',
  AIRBNB_API_USER_ID: null,
  AIRBNB_API_GLOBAL_USER_ID: null,
  AIRBNB_API_KEY: 'k',
  AIRBNB_API_INBOX_HASH: 'h1',
  AIRBNB_API_THREAD_HASH: 'h2',
  WATERMARKS_PATH: '/tmp/wm.json',
};

let baseUrl: string;
let server: ReturnType<ReturnType<typeof buildApp>['listen']>;

beforeAll(async () => {
  // The handler gates on isAuthEpochReady() so the auth-epoch must be primed
  // before any test attempts a successful pass-through.
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();

  const app = buildApp(env);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function signedHeaders(opts: {
  method: string;
  path: string;
  body: Buffer;
  hostId?: string;
  timestamp?: number;
  nonce?: string;
  /** Override body-hash header (for tampering tests). */
  bodyHashOverride?: string;
}): Record<string, string> {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? 'a1b2c3d4-5678-4abc-9def-0123456789ab';
  const hostId = opts.hostId ?? HOST_ID;
  const bodyHash = opts.body.byteLength === 0 ? EMPTY_BODY_SHA256 : sha256Hex(opts.body);
  const signature = signHmac(HMAC_SECRET, {
    method: opts.method,
    path: opts.path,
    timestamp,
    nonce,
    hostId,
    bodyHash,
  });
  return {
    'content-type': 'application/json',
    'x-signature': signature,
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-host-id': hostId,
    'x-body-hash': opts.bodyHashOverride ?? bodyHash,
  };
}

describe('/scrape-reservation-list HMAC integration', () => {
  it('rejects unauthenticated POST with 401', async () => {
    const r = await fetch(`${baseUrl}/scrape-reservation-list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host_id: HOST_ID }),
    });
    expect(r.status).toBe(401);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('unauthorized');
  });

  it('rejects POST with tampered signature with 401', async () => {
    const body = Buffer.from(JSON.stringify({ host_id: HOST_ID }), 'utf8');
    const headers = signedHeaders({
      method: 'POST',
      path: '/scrape-reservation-list',
      body,
    });
    headers['x-signature'] = 'f'.repeat(64);
    const r = await fetch(`${baseUrl}/scrape-reservation-list`, {
      method: 'POST',
      headers,
      body,
    });
    expect(r.status).toBe(401);
  });

  it('rejects POST with mismatched X-Body-Hash header with 401', async () => {
    const body = Buffer.from(JSON.stringify({ host_id: HOST_ID }), 'utf8');
    const headers = signedHeaders({
      method: 'POST',
      path: '/scrape-reservation-list',
      body,
      bodyHashOverride: '0'.repeat(64),
    });
    const r = await fetch(`${baseUrl}/scrape-reservation-list`, {
      method: 'POST',
      headers,
      body,
    });
    expect(r.status).toBe(401);
  });

  it('reaches the handler when signature is valid (handler returns 401 invalid_cookies via mocked session gate)', async () => {
    const body = Buffer.from(JSON.stringify({ host_id: HOST_ID }), 'utf8');
    const headers = signedHeaders({
      method: 'POST',
      path: '/scrape-reservation-list',
      body,
    });
    const r = await fetch(`${baseUrl}/scrape-reservation-list`, {
      method: 'POST',
      headers,
      body,
    });
    expect(r.status).toBe(401);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('invalid_cookies');
  });
});
