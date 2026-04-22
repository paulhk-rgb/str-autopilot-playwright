/**
 * Outbound HMAC-signed callbacks: machine -> staysync-app Edge Function.
 * Spec §2.6 + §2.7.
 *
 * The callback endpoint (staysync-app: src/app/api/playwright-callback/route.ts) verifies:
 *   X-Playwright-Signature OR X-Signature (current impl uses `x-playwright-signature`)
 *   X-Host-Id
 *   X-Timestamp (ISO8601 currently on that endpoint; unix-seconds on this sender).
 *
 * NOTE: The staysync-app callback route reads `payload.timestamp` as ISO8601 while spec §2.6
 * mandates unix-seconds in X-Timestamp headers. We include BOTH:
 *   - X-Timestamp (unix seconds) for HMAC canonical message (spec §2.6)
 *   - payload.timestamp (ISO8601) inside the JSON body for the current handler's skew check
 * When staysync-app is updated to a unified scheme we'll converge.
 */

import { randomUUID } from 'crypto';
import type { MachineEnv } from './env';
import { EMPTY_BODY_SHA256, sha256Hex, signHmac } from './hmac';

export interface CallbackHeaders {
  [k: string]: string;
}

/** Build HMAC-signed headers for POST {env.CALLBACK_URL}{subpath}. */
export function buildCallbackHeaders(opts: {
  env: MachineEnv;
  method: string;
  path: string;      // URL path of the callback endpoint (URL.pathname)
  bodyBytes: Uint8Array | Buffer;
}): CallbackHeaders {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const bodyHash = opts.bodyBytes.byteLength === 0 ? EMPTY_BODY_SHA256 : sha256Hex(opts.bodyBytes);

  const signature = signHmac(opts.env.HMAC_SECRET, {
    method: opts.method.toUpperCase(),
    path: opts.path,
    timestamp,
    nonce,
    hostId: opts.env.HOST_ID,
    bodyHash,
  });

  return {
    'Content-Type': 'application/json',
    'X-Signature': signature,
    'X-Playwright-Signature': signature, // compat with current staysync-app callback route
    'X-Timestamp': String(timestamp),
    'X-Nonce': nonce,
    'X-Host-Id': opts.env.HOST_ID,
    'X-Body-Hash': bodyHash,
  };
}

/** Fetch wrapper with basic retry. Returns the HTTP response object.
 *
 * Each retry re-signs with a FRESH timestamp + nonce (Codex P1 fix): the callback verifier
 * INSERTs nonces into runtime_state on ON CONFLICT DO NOTHING (spec §2.6 step 2b). If a retry
 * reuses the original nonce, the verifier rejects it as a replay. Body bytes are stable
 * across retries — only the signature envelope rotates.
 */
export async function postCallback(opts: {
  env: MachineEnv;
  body: Record<string, unknown>;
  retries?: number;
  timeoutMs?: number;
}): Promise<{ status: number; ok: boolean; bodyText: string }> {
  const url = new URL(opts.env.CALLBACK_URL);
  const bodyStr = JSON.stringify(opts.body);
  const bodyBytes = Buffer.from(bodyStr, 'utf8');

  const maxRetries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Build fresh headers per attempt so the timestamp is within drift window and the nonce
    // is unique per attempt (receiver's replay-detect INSERT wouldn't accept a reused nonce).
    const headers = buildCallbackHeaders({
      env: opts.env,
      method: 'POST',
      path: url.pathname,
      bodyBytes,
    });

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(opts.env.CALLBACK_URL, {
          method: 'POST',
          headers,
          body: bodyStr,
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.ok) return { status: res.status, ok: true, bodyText: text };
        // 4xx: don't retry (auth failures won't self-heal)
        if (res.status >= 400 && res.status < 500) {
          return { status: res.status, ok: false, bodyText: text };
        }
        lastErr = new Error(`callback ${res.status}: ${text}`);
      } finally {
        clearTimeout(tid);
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxRetries) {
      const backoff = 500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
