/**
 * POST /scrape-reservation-list — HMAC-authed.
 *
 * Reservation-list scraper for the historical-sync inventory audit
 * (staysync-app PR5, Issue #45). Reuses the persistent browser context
 * established by /inject-cookies — no re-auth.
 *
 * Request body:
 *   { host_id: string, mode?: 'initial' | 'incremental' | 'full', since?: ISO8601 }
 *
 * Response (success):
 *   { reservations: Reservation[], scraped_at: ISO8601, account_email: string }
 *
 * Error envelope: `{ error: string, message?: string }` — matches /sync.
 * (The older /inject-cookies endpoint uses `{ status:'error', reason }`;
 * /sync established the simpler shape and new endpoints follow that.)
 *
 * NOTE: This PR ships the endpoint contract, HMAC integration, and request
 * validation. The real Airbnb /hosting/reservations DOM scrape (status filter,
 * pagination, payout fields) is a follow-up — same staging pattern as /sync's
 * stub scraper. The endpoint currently returns an empty `reservations` array
 * with a populated `scraped_at` so downstream worker code can be wired against
 * the contract before the scraper lands.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { getBrowserContext, hasAirbnbSession } from '../playwright/browser';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import { scrapeReservationList } from '../playwright/scrape-reservations';

export interface Reservation {
  conf_code: string;
  guest_name: string;
  check_in: string;
  check_out: string;
  status: string;
  listing_id?: string | null;
  total_payout?: number | null;
}

interface ScrapeReservationListBody {
  host_id: string;
  mode?: 'initial' | 'incremental' | 'full';
  since?: string;
}

/**
 * Permissive ISO8601 / RFC3339 timestamp check.
 *
 * Accepts the canonical Z-suffixed form emitted by JS `Date#toISOString()`
 * (e.g. `2026-04-01T00:00:00.000Z`) PLUS the equally valid forms callers
 * outside JS routinely produce: no fractional seconds (`2026-04-01T00:00:00Z`),
 * numeric offsets (`2026-04-01T00:00:00+00:00`), and 1-6 digit fractional
 * seconds. Rejects ambiguous/locale-dependent inputs like `'2026-04-28 10:30:00'`
 * (space separator) or `'04/28/2026'` that `Date.parse` would otherwise accept.
 *
 * Strict round-trip equality (`new Date(s).toISOString() === s`) was tried in
 * the prior cycle but rejected `2026-04-01T00:00:00Z` and offset forms — too
 * strict for a contract that says "ISO8601" without pinning a sub-format.
 */
const ISO8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIso8601(s: string): boolean {
  return ISO8601_REGEX.test(s) && Number.isFinite(Date.parse(s));
}

function isValidBody(body: unknown): body is ScrapeReservationListBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeReservationListBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (
    b.mode !== undefined &&
    b.mode !== 'initial' &&
    b.mode !== 'incremental' &&
    b.mode !== 'full'
  ) {
    return false;
  }
  if (b.since !== undefined) {
    if (typeof b.since !== 'string') return false;
    if (!isIso8601(b.since)) return false;
  }
  return true;
}

export function scrapeReservationListHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    // Auth-epoch readiness MUST be checked before any browser/cookie read so
    // a concurrent /inject-cookies (which sets ready=false BEFORE rewriting
    // cookies) is detected before we can observe a half-rotated state.
    if (!isAuthEpochReady()) {
      return res.status(409).json({ error: 'auth_epoch_not_ready' });
    }
    const epochAtStart = currentAuthEpoch();

    let ctx;
    try {
      ctx = await getBrowserContext({ profileDir: env.PROFILE_DIR });
    } catch (err) {
      return res.status(500).json({
        error: 'browser_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    let sessionOk: boolean;
    try {
      sessionOk = await hasAirbnbSession(ctx);
    } catch (err) {
      // A concurrent rotation may have closed the cookie store mid-call; surface
      // the rotation as 409 instead of masking it as 500 session_check_failed.
      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }
      return res.status(500).json({
        error: 'session_check_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (!sessionOk) {
      // Re-verify epoch before returning invalid_cookies — a concurrent rotation
      // may have produced the false return; that's a retryable rotation, not a
      // permanently invalid session.
      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }
      return res.status(401).json({ error: 'invalid_cookies' });
    }

    try {
      const result = await scrapeReservationList(ctx, {
        mode: req.body.mode ?? 'incremental',
        since: req.body.since,
      });

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }

      // Stub mode is signalled via the `X-Stub: true` response header — the
      // 200 body matches Issue #45 exactly (`{ reservations, scraped_at,
      // account_email }`) so strict consumer parsers cannot reject it. The
      // staysync worker MUST inspect this header and skip persistence of empty
      // fields (e.g. `account_email`) when set. Header disappears once the
      // real scraper lands.
      if (result.stub) res.setHeader('X-Stub', 'true');
      return res.status(200).json({
        reservations: result.reservations,
        scraped_at: result.scrapedAt,
        account_email: result.accountEmail,
      });
    } catch (err) {
      // Mid-scrape rotation typically closes the browser context, surfacing as
      // a Playwright `Target closed` throw. Re-check the epoch so the worker
      // sees 409 (retryable) rather than 500 (treated as hard failure).
      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }
      return res.status(500).json({
        error: 'scrape_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
