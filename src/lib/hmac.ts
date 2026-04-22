/**
 * HMAC sign/verify helpers.
 * Spec: ~/str-autopilot/specs/DAY4-integration-patterns.md §2.6
 *
 * Canonical message format:
 *   {method}\n{path}\n{timestamp}\n{nonce}\n{host_id}\n{body_sha256}
 *
 * - timestamp: Unix epoch SECONDS (integer) — NOT ISO8601 (R2 fix Gemini P1-3: avoids TZ ambiguity)
 * - body_sha256: hex SHA-256 of the raw body bytes; SHA-256 of empty string if no body
 * - signature: HMAC-SHA256(secret, message), hex-encoded
 * - clock drift tolerance: 60 seconds (step 1 of machine verification)
 *
 * Machine verification responsibilities (spec §2.6 "Playwright machine verification"):
 *   1. Parse X-Timestamp, reject if |now - ts| > 60s
 *   2. Verify X-Host-Id matches HOST_ID env var (machine-identity binding)
 *   3. Recompute expected signature from canonical message
 *   4. Constant-time compare vs X-Signature
 *   5. Reject 401 on mismatch
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const CLOCK_DRIFT_TOLERANCE_SECONDS = 60;

/**
 * UUID format (any version) — spec §2.6 mandates UUIDv4 for nonces, but we accept any well-formed
 * UUID to stay forward-compatible with future nonce schemes. The constraint-enforcer is the
 * server-side nonce replay cache (staysync-app §2.6 step 2b), which dedupes on the full string.
 */
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** SHA-256 hex of the raw body bytes. Empty string hash is used when no body is present. */
export function sha256Hex(bodyBytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bodyBytes).digest('hex');
}

/** The SHA-256 of the empty string — used as body hash for requests with no body. */
export const EMPTY_BODY_SHA256 = sha256Hex(Buffer.alloc(0));

export interface HmacInputs {
  method: string;
  path: string;
  timestamp: number;    // unix epoch seconds
  nonce: string;        // UUIDv4
  hostId: string;
  bodyHash: string;     // hex SHA-256 of raw body (or EMPTY_BODY_SHA256)
}

/** Build the canonical message string per spec §2.6. */
export function canonicalMessage(i: HmacInputs): string {
  return [i.method, i.path, String(i.timestamp), i.nonce, i.hostId, i.bodyHash].join('\n');
}

/** Compute HMAC-SHA256 signature, hex-encoded. */
export function signHmac(secretHex: string, inputs: HmacInputs): string {
  // Secret is stored as hex (encoded from gen_random_bytes(32) in PG).
  // For HMAC key, interpret as the hex string directly per spec (Fly env injection is hex-encoded).
  const secretBuf = Buffer.from(secretHex, 'hex');
  if (secretBuf.length === 0) {
    throw new Error('HMAC secret is empty');
  }
  return createHmac('sha256', secretBuf).update(canonicalMessage(inputs)).digest('hex');
}

/**
 * Verify an incoming request's signature and timestamp.
 * Returns { ok: true } or { ok: false, reason: <code> } — never throws for auth failures.
 * The reason strings are internal diagnostics; 401 responses should NOT leak them to clients.
 */
export interface VerifyResult {
  ok: boolean;
  reason?:
    | 'missing_headers'
    | 'bad_timestamp'
    | 'bad_nonce'
    | 'clock_drift'
    | 'host_id_mismatch'
    | 'bad_signature_format'
    | 'signature_mismatch';
}

export interface VerifyHeaders {
  signature?: string | string[] | undefined;
  timestamp?: string | string[] | undefined;
  nonce?: string | string[] | undefined;
  hostId?: string | string[] | undefined;
  bodyHash?: string | string[] | undefined;
}

export interface VerifyParams {
  method: string;
  path: string;
  bodyBytes: Uint8Array | Buffer;
  headers: VerifyHeaders;
  secretHex: string;
  expectedHostId: string;
  now?: number; // unix seconds, for testing
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function verifyHmacRequest(p: VerifyParams): VerifyResult {
  const sig = firstHeader(p.headers.signature);
  const ts = firstHeader(p.headers.timestamp);
  const nonce = firstHeader(p.headers.nonce);
  const hdrHost = firstHeader(p.headers.hostId);
  const hdrBodyHash = firstHeader(p.headers.bodyHash);

  if (!sig || !ts || !nonce || !hdrHost) {
    return { ok: false, reason: 'missing_headers' };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || !Number.isInteger(tsNum)) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  if (!UUID_REGEX.test(nonce)) {
    return { ok: false, reason: 'bad_nonce' };
  }

  const now = p.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > CLOCK_DRIFT_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'clock_drift' };
  }

  if (hdrHost !== p.expectedHostId) {
    return { ok: false, reason: 'host_id_mismatch' };
  }

  // Compute body hash from request bytes. If caller sent X-Body-Hash, we could compare it,
  // but the HMAC already binds the body hash, so we recompute from bytes and use that in the message.
  const computedBodyHash = sha256Hex(p.bodyBytes);

  // If the client provided X-Body-Hash, reject if it disagrees — early fail rather than letting
  // HMAC mismatch surface as a generic 401.
  if (hdrBodyHash && hdrBodyHash.toLowerCase() !== computedBodyHash.toLowerCase()) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const expectedSig = signHmac(p.secretHex, {
    method: p.method.toUpperCase(),
    path: p.path,
    timestamp: tsNum,
    nonce,
    hostId: hdrHost,
    bodyHash: computedBodyHash,
  });

  // Hex length check before constant-time compare (timingSafeEqual throws on length mismatch).
  if (sig.length !== expectedSig.length) {
    return { ok: false, reason: 'bad_signature_format' };
  }

  let sigBuf: Buffer;
  let expBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expectedSig, 'hex');
  } catch {
    return { ok: false, reason: 'bad_signature_format' };
  }

  if (sigBuf.length !== expBuf.length || sigBuf.length === 0) {
    return { ok: false, reason: 'bad_signature_format' };
  }

  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true };
}
