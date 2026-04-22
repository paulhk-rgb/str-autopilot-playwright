/**
 * HMAC sign/verify unit tests.
 * Spec §2.6 — canonical message: {method}\n{path}\n{timestamp}\n{nonce}\n{host_id}\n{body_sha256}
 *
 * Covers:
 *  - valid signature
 *  - timestamp skew beyond 60s
 *  - wrong host_id
 *  - missing headers
 *  - tampered body
 *  - malformed signature
 */

import { describe, expect, it } from 'vitest';
import {
  CLOCK_DRIFT_TOLERANCE_SECONDS,
  canonicalMessage,
  EMPTY_BODY_SHA256,
  sha256Hex,
  signHmac,
  verifyHmacRequest,
} from '../src/lib/hmac';

const SECRET = '7b2e2f1a0d6c4e6e89ab22c3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d';
const HOST_ID = '11111111-2222-3333-4444-555555555555';

function buildSignedRequest(opts: {
  method?: string;
  path?: string;
  body?: Buffer;
  now?: number;
  overrideHostId?: string;
  overrideNonce?: string;
}) {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/sync';
  const body = opts.body ?? Buffer.from('{"host_id":"x","mode":"incremental"}', 'utf8');
  const timestamp = opts.now ?? Math.floor(Date.now() / 1000);
  const nonce = opts.overrideNonce ?? 'a1b2c3d4-5678-4abc-9def-0123456789ab';
  const hostId = opts.overrideHostId ?? HOST_ID;
  const bodyHash = body.byteLength === 0 ? EMPTY_BODY_SHA256 : sha256Hex(body);

  const signature = signHmac(SECRET, { method, path, timestamp, nonce, hostId, bodyHash });

  return { method, path, body, timestamp, nonce, hostId, bodyHash, signature };
}

describe('HMAC canonical message', () => {
  it('joins fields with \\n in spec order', () => {
    const msg = canonicalMessage({
      method: 'POST',
      path: '/sync',
      timestamp: 1700000000,
      nonce: 'abc',
      hostId: 'host',
      bodyHash: 'hash',
    });
    expect(msg).toBe('POST\n/sync\n1700000000\nabc\nhost\nhash');
  });

  it('computes a stable SHA-256 for empty bodies', () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(EMPTY_BODY_SHA256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('verifyHmacRequest', () => {
  it('accepts a valid signature within tolerance', () => {
    const req = buildSignedRequest({});
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        timestamp: String(req.timestamp),
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects missing headers', () => {
    const req = buildSignedRequest({});
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        // missing timestamp
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_headers');
  });

  it('rejects timestamp outside 60s drift window', () => {
    const now = 1_700_000_000;
    const req = buildSignedRequest({ now: now - (CLOCK_DRIFT_TOLERANCE_SECONDS + 5) });
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        timestamp: String(req.timestamp),
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
      now,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('clock_drift');
  });

  it('accepts timestamps right at the edge of the drift window', () => {
    const now = 1_700_000_000;
    const req = buildSignedRequest({ now: now - CLOCK_DRIFT_TOLERANCE_SECONDS });
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        timestamp: String(req.timestamp),
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
      now,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when X-Host-Id does not match machine HOST_ID', () => {
    const req = buildSignedRequest({ overrideHostId: 'deadbeef-0000-0000-0000-000000000000' });
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        timestamp: String(req.timestamp),
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('host_id_mismatch');
  });

  it('rejects signature mismatch from tampered body', () => {
    const req = buildSignedRequest({});
    // Caller tampered with body after signing — recomputed body hash will differ.
    const tampered = Buffer.from('{"mode":"full"}', 'utf8');
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: tampered,
      headers: {
        signature: req.signature,
        timestamp: String(req.timestamp),
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects malformed signature (non-hex)', () => {
    const req = buildSignedRequest({});
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: 'not-hex-!!!',
        timestamp: String(req.timestamp),
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(false);
    // Could be bad_signature_format OR signature_mismatch depending on length — both acceptable rejections.
    expect(['bad_signature_format', 'signature_mismatch']).toContain(result.reason);
  });

  it('rejects bad timestamp (non-integer)', () => {
    const req = buildSignedRequest({});
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        timestamp: 'yesterday',
        nonce: req.nonce,
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_timestamp');
  });

  it('rejects mismatched X-Body-Hash header', () => {
    const req = buildSignedRequest({});
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        timestamp: String(req.timestamp),
        nonce: req.nonce,
        hostId: req.hostId,
        bodyHash: 'deadbeef'.repeat(8), // 64 hex chars, wrong value
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects non-UUID nonce', () => {
    const req = buildSignedRequest({});
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: req.body,
      headers: {
        signature: req.signature,
        timestamp: String(req.timestamp),
        nonce: 'not-a-uuid',
        hostId: req.hostId,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_nonce');
  });

  it('signs and verifies an empty-body GET request', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = '00000000-0000-4000-8000-000000000000';
    const sig = signHmac(SECRET, {
      method: 'GET',
      path: '/ping',
      timestamp,
      nonce,
      hostId: HOST_ID,
      bodyHash: EMPTY_BODY_SHA256,
    });
    const result = verifyHmacRequest({
      method: 'GET',
      path: '/ping',
      bodyBytes: Buffer.alloc(0),
      headers: {
        signature: sig,
        timestamp: String(timestamp),
        nonce,
        hostId: HOST_ID,
      },
      secretHex: SECRET,
      expectedHostId: HOST_ID,
    });
    expect(result.ok).toBe(true);
  });
});
