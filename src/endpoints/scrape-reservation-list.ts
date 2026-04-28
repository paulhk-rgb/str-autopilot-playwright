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
 * Strict ISO8601 check: parsable AND `Date#toISOString()` round-trips to the
 * same string. Rejects ambiguous/locale-dependent forms like `'2026-04-28 10:30'`
 * or `'04/28/2026'` that `Date.parse` would otherwise accept.
 */
function isStrictIso8601(s: string): boolean {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return false;
  try {
    return new Date(t).toISOString() === s;
  } catch {
    return false;
  }
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
    if (!isStrictIso8601(b.since)) return false;
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
      return res.status(500).json({
        error: 'session_check_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (!sessionOk) {
      return res.status(401).json({ error: 'invalid_cookies' });
    }

    if (!isAuthEpochReady()) {
      return res.status(409).json({ error: 'auth_epoch_not_ready' });
    }
    const epochAtStart = currentAuthEpoch();

    try {
      const result = await scrapeReservationList(ctx, {
        mode: req.body.mode ?? 'incremental',
        since: req.body.since,
      });

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }

      // Response shape per the staysync historical-sync host worker contract:
      //   { reservations, scraped_at, account_email, _stub?: true }
      // The `_stub` flag is a machine-readable signal that the real DOM scraper
      // is not yet wired (handler forwards it from the scraper layer). Worker
      // MUST inspect `_stub` and skip persistence of `account_email` (and any
      // empty fields) when present. Field is removed once the real scraper
      // lands; consumer parsers must accept its presence today and its absence
      // tomorrow.
      const body: {
        reservations: Reservation[];
        scraped_at: string;
        account_email: string;
        _stub?: true;
      } = {
        reservations: result.reservations,
        scraped_at: result.scrapedAt,
        account_email: result.accountEmail,
      };
      if (result.stub) body._stub = true;
      return res.status(200).json(body);
    } catch (err) {
      return res.status(500).json({
        error: 'scrape_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
