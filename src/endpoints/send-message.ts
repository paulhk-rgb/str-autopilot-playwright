/**
 * POST /send-message — HMAC-authed.
 *
 * Sends one Airbnb in-app message to an exact persisted thread id. This endpoint
 * does not search Airbnb by guest name and never marks StaySync messages sent
 * directly; it reports browser evidence through the existing HMAC callback.
 */

import type { Request, Response } from 'express';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MachineEnv } from '../lib/env';
import { postCallback } from '../lib/callback';
import { tryAcquireSingleFlight } from '../lib/single-flight';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import {
  sendAirbnbMessage,
  type SendAirbnbMessageInput,
  type SendAirbnbMessageResult,
} from '../playwright/send-message';

interface SendMessageBody {
  host_id: string;
  message_id: string;
  conversation_airbnb_id: string;
  guest_name: string;
  message: string;
  check_in?: string | null;
  check_out?: string | null;
  confirmation_code?: string | null;
  property_name?: string | null;
  message_body_hash?: string | null;
  dispatch_attempt_key?: string | null;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const THREAD_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONF_CODE_RE = /^HM[A-Z0-9-]{6,}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const REDACTED_PLACEHOLDER_PATTERN =
  /(?:\[(?:REDACTED|PRIVATE|TOKEN|SECRET)[^\]]*\]|<\s*(?:REDACTED|PRIVATE|TOKEN|SECRET)[^>]*>|\{\{\s*(?:REDACTED|PRIVATE|TOKEN|SECRET)[^}]*\}\}|\b(?:REDACTED|PRIVATE|TOKEN|SECRET)_[A-Z0-9_]+\b)/i;
const SCENARIO_PATTERN = /\b(?:HMSCEN[A-Z0-9]*|TEST RESERVATION|FAKE RESERVATION)\b/i;
const SEND_LEDGER_TTL_MS = 60 * 60_000;

interface SendLedgerEntry {
  key: string;
  createdAtMs: number;
  status: 'browser_confirmed' | 'submitted_unconfirmed';
  callbackDelivered: boolean;
  error?: string;
}

const sendLedger = new Map<string, SendLedgerEntry>();

function isIsoDate(value: string | null | undefined): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function isOptionalShortString(value: unknown, maxLength: number): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= maxLength);
}

function hasUnsafeMarker(value: string | null | undefined): boolean {
  if (!value) return false;
  return REDACTED_PLACEHOLDER_PATTERN.test(value) || SCENARIO_PATTERN.test(value);
}

function isValidBody(body: unknown): body is SendMessageBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<SendMessageBody>;
  if (typeof b.host_id !== 'string' || !UUID_RE.test(b.host_id)) return false;
  if (typeof b.message_id !== 'string' || !UUID_RE.test(b.message_id)) return false;
  if (typeof b.conversation_airbnb_id !== 'string' || !THREAD_ID_RE.test(b.conversation_airbnb_id)) return false;
  if (typeof b.guest_name !== 'string' || b.guest_name.trim().length < 2 || b.guest_name.length > 160) return false;
  if (typeof b.message !== 'string' || b.message.trim().length === 0 || b.message.length > 4000) return false;
  if (!isOptionalShortString(b.check_in, 10) || !isIsoDate(b.check_in)) return false;
  if (!isOptionalShortString(b.check_out, 10) || !isIsoDate(b.check_out)) return false;
  if (!isOptionalShortString(b.confirmation_code, 32)) return false;
  if (b.confirmation_code && !CONF_CODE_RE.test(b.confirmation_code)) return false;
  if (!isOptionalShortString(b.property_name, 240)) return false;
  if (!isOptionalShortString(b.message_body_hash, 64)) return false;
  if (b.message_body_hash && !SHA256_RE.test(b.message_body_hash)) return false;
  if (!isOptionalShortString(b.dispatch_attempt_key, 320)) return false;

  if (
    hasUnsafeMarker(b.guest_name) ||
    hasUnsafeMarker(b.message) ||
    hasUnsafeMarker(b.confirmation_code) ||
    hasUnsafeMarker(b.property_name)
  ) {
    return false;
  }

  return true;
}

function inputFromBody(body: SendMessageBody): SendAirbnbMessageInput {
  return {
    conversation_airbnb_id: body.conversation_airbnb_id.trim(),
    guest_name: body.guest_name.trim(),
    message: body.message.trim(),
    check_in: body.check_in || null,
    check_out: body.check_out || null,
    confirmation_code: body.confirmation_code?.trim().toUpperCase() || null,
    property_name: body.property_name?.trim() || null,
  };
}

function ledgerKey(body: SendMessageBody): string {
  return `${body.host_id}:${body.message_id}`;
}

function sendLedgerDir(env: MachineEnv): string {
  return path.join(env.PROFILE_DIR, 'send-message-ledger');
}

function sendLedgerPath(env: MachineEnv, body: SendMessageBody): string {
  return path.join(sendLedgerDir(env), `${body.host_id}_${body.message_id}.json`);
}

function pruneSendLedger(nowMs = Date.now()): void {
  for (const [key, entry] of sendLedger.entries()) {
    if (nowMs - entry.createdAtMs > SEND_LEDGER_TTL_MS) {
      sendLedger.delete(key);
    }
  }
}

function isFreshLedgerEntry(entry: SendLedgerEntry, nowMs = Date.now()): boolean {
  return nowMs - entry.createdAtMs <= SEND_LEDGER_TTL_MS;
}

function parseLedgerEntry(raw: unknown): SendLedgerEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<SendLedgerEntry>;
  if (typeof entry.key !== 'string') return null;
  if (typeof entry.createdAtMs !== 'number') return null;
  if (entry.status !== 'browser_confirmed' && entry.status !== 'submitted_unconfirmed') return null;
  if (typeof entry.callbackDelivered !== 'boolean') return null;
  if (entry.error !== undefined && typeof entry.error !== 'string') return null;
  return entry as SendLedgerEntry;
}

async function readDiskLedgerEntry(env: MachineEnv, body: SendMessageBody): Promise<SendLedgerEntry | null> {
  const filePath = sendLedgerPath(env, body);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseLedgerEntry(JSON.parse(raw));
    if (!parsed || !isFreshLedgerEntry(parsed)) {
      await rm(filePath, { force: true }).catch(() => undefined);
      return null;
    }
    sendLedger.set(ledgerKey(body), parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function resetSendLedgerForTesting(profileDir?: string): Promise<void> {
  sendLedger.clear();
  if (profileDir) {
    await rm(path.join(profileDir, 'send-message-ledger'), { recursive: true, force: true });
  }
}

function clearSendLedgerMemoryForTesting(): void {
  sendLedger.clear();
}

async function getSendLedgerEntry(env: MachineEnv, body: SendMessageBody): Promise<SendLedgerEntry | null> {
  pruneSendLedger();
  const memoryEntry = sendLedger.get(ledgerKey(body));
  if (memoryEntry) return memoryEntry;
  return readDiskLedgerEntry(env, body);
}

async function recordSendLedgerEntry(
  env: MachineEnv,
  body: SendMessageBody,
  entry: Omit<SendLedgerEntry, 'key' | 'createdAtMs'>,
): Promise<void> {
  pruneSendLedger();
  const key = ledgerKey(body);
  const fullEntry = {
    key,
    createdAtMs: Date.now(),
    ...entry,
  };
  sendLedger.set(key, fullEntry);
  try {
    await mkdir(sendLedgerDir(env), { recursive: true });
    await writeFile(sendLedgerPath(env, body), JSON.stringify(fullEntry), 'utf8');
  } catch {
    // Best-effort duplicate suppression. The app-side dispatched log remains the durable guard.
  }
}

async function postSendResultCallback(opts: {
  env: MachineEnv;
  body: SendMessageBody;
  status: 'confirmed' | 'failed';
  error?: string;
}) {
  return postCallback({
    env: opts.env,
    body: {
      action: 'send_result',
      message_id: opts.body.message_id,
      status: opts.status,
      error: opts.error,
      timestamp: new Date().toISOString(),
    },
  });
}

function isAirbnbAuthFailureResponse(error: string): boolean {
  return error === 'invalid_cookies' || error === 'auth_epoch_changed' || error === 'auth_epoch_not_ready';
}

function statusForSendException(error: string): number {
  if (error === 'auth_epoch_changed' || error === 'auth_epoch_not_ready') return 503;
  if (error === 'invalid_cookies') return 401;
  return 500;
}

async function handleSendResult(
  env: MachineEnv,
  body: SendMessageBody,
  result: SendAirbnbMessageResult,
  res: Response,
) {
  if (result.status === 'confirmed') {
    await recordSendLedgerEntry(env, body, { status: 'browser_confirmed', callbackDelivered: false });
    try {
      await postSendResultCallback({ env, body, status: 'confirmed' });
      await recordSendLedgerEntry(env, body, { status: 'browser_confirmed', callbackDelivered: true });
    } catch {
      return res.status(202).json({
        ok: true,
        status: 'callback_failed_after_send',
        do_not_retry_browser_send: true,
      });
    }

    return res.status(200).json({ ok: true, status: 'confirmed' });
  }

  if (result.status === 'submitted_unconfirmed') {
    await recordSendLedgerEntry(env, body, {
      status: 'submitted_unconfirmed',
      callbackDelivered: false,
      error: result.error,
    });
    return res.status(202).json({
      ok: true,
      status: 'submitted_unconfirmed',
      error: result.error,
      do_not_retry_browser_send: true,
    });
  }

  try {
    await postSendResultCallback({ env, body, status: 'failed', error: result.error });
  } catch {
    return res.status(500).json({
      ok: false,
      error: 'callback_failed_before_send',
    });
  }

  return res.status(200).json({
    ok: false,
    status: 'failed',
    error: result.error,
  });
}

async function handleLedgerDuplicate(env: MachineEnv, body: SendMessageBody, entry: SendLedgerEntry, res: Response) {
  if (entry.status === 'browser_confirmed') {
    if (!entry.callbackDelivered) {
      try {
        await postSendResultCallback({ env, body, status: 'confirmed' });
        await recordSendLedgerEntry(env, body, { status: 'browser_confirmed', callbackDelivered: true });
        return res.status(200).json({
          ok: true,
          status: 'confirmed',
          duplicate_suppressed: true,
        });
      } catch {
        return res.status(202).json({
          ok: true,
          status: 'callback_failed_after_send',
          duplicate_suppressed: true,
          do_not_retry_browser_send: true,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      status: 'already_confirmed',
      duplicate_suppressed: true,
    });
  }

  return res.status(202).json({
    ok: true,
    status: 'submitted_unconfirmed',
    error: entry.error ?? 'verification_failed_after_click',
    duplicate_suppressed: true,
    do_not_retry_browser_send: true,
  });
}

export function sendMessageHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    const ledgerEntry = await getSendLedgerEntry(env, req.body);
    if (ledgerEntry) {
      return handleLedgerDuplicate(env, req.body, ledgerEntry, res);
    }

    const counterAtStart = currentAuthEpoch();
    if (counterAtStart > 0 && !isAuthEpochReady()) {
      return res.status(503).json({ error: 'auth_epoch_not_ready' });
    }
    const epochAtStart = counterAtStart;

    const lease = tryAcquireSingleFlight('send-message');
    if (!lease) {
      return res.status(409).json({ error: 'send_already_running' });
    }

    try {
      let ctx;
      try {
        ctx = await getBrowserContext({ profileDir: env.PROFILE_DIR });
      } catch (err) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        return res.status(500).json({
          error: 'browser_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(503).json({ error: 'auth_epoch_changed' });
      }

      let sessionOk: boolean;
      try {
        sessionOk = await readAirbnbSessionStrict(ctx);
      } catch (err) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        return res.status(500).json({
          error: 'session_check_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!sessionOk) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        return res.status(401).json({ error: 'invalid_cookies' });
      }

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(503).json({ error: 'auth_epoch_changed' });
      }

      try {
        const result = await sendAirbnbMessage(ctx, inputFromBody(req.body));
        return handleSendResult(env, req.body, result, res);
      } catch (err) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        const message = err instanceof Error ? err.message : String(err);
        const code = isAirbnbAuthFailureResponse(message) ? message : 'send_failed';
        return res.status(statusForSendException(code)).json({
          error: code,
          message,
        });
      }
    } finally {
      lease.release();
    }
  };
}

export const __sendMessageEndpointTestHooks = {
  CONF_CODE_RE,
  ISO_DATE_RE,
  SCENARIO_PATTERN,
  SEND_LEDGER_TTL_MS,
  THREAD_ID_RE,
  clearSendLedgerMemoryForTesting,
  getSendLedgerEntry,
  isValidBody,
  pruneSendLedger,
  resetSendLedgerForTesting,
};
