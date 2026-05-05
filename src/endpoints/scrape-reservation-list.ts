/**
 * POST /scrape-reservation-list — HMAC-authed.
 *
 * Reservation-list scraper for the historical-sync inventory audit
 * (staysync-app PR5, Issue #45). Reuses the persistent browser context
 * established by /inject-cookies — no re-auth.
 *
 * Request body:
 *   {
 *     host_id: string,
 *     mode: 'initial' | 'incremental' | 'full',
 *     window_start: 'YYYY-MM-DD',
 *     window_end: 'YYYY-MM-DD',
 *     cursor?: string | null
 *   }
 *
 * Response (success):
 *   {
 *     schema_version: 3,
 *     mode,
 *     window_start,
 *     window_end,
 *     page_cursor,
 *     next_page_cursor,
 *     page_index,
 *     is_complete,
 *     scraped_at,
 *     reservations,
 *     diagnostics
 *   }
 *
 * Error envelope: `{ error: string, message?: string }` — matches /sync.
 * (The older /inject-cookies endpoint uses `{ status:'error', reason }`;
 * /sync established the simpler shape and new endpoints follow that.)
 *
 * The endpoint must not return an empty successful response unless the scraper
 * positively detects Airbnb's empty-state UI. Source-of-truth inventory cannot
 * silently degrade to "0 reservations".
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import {
  ReservationListCursorError,
  scrapeReservationList,
} from '../playwright/scrape-reservations';

export interface Reservation {
  conf_code: string;
  guest_name: string;
  check_in: string;
  check_out: string;
  status_text: string;
  listing_id?: string | null;
  listing_name?: string | null;
  guest_count?: number | null;
  total_payout?: number | null;
  guest_paid?: number | null;
  reservation_url?: string | null;
  conversation_airbnb_id?: string | null;
}

interface ScrapeReservationListBody {
  host_id: string;
  mode: 'initial' | 'incremental' | 'full';
  window_start: string;
  window_end: string;
  cursor?: string | null;
}

/**
 * Strict YYYY-MM-DD date check. The app owns window selection; the machine only
 * verifies a bounded scrape window.
 */
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  // `Date.UTC(year, month, 0)` rolls back to the last day of the prior month.
  // Pass `month` as the 1-indexed input value (the API treats it as 0-indexed
  // + advance by `0`, which equals the last day of `month - 1` in 0-index =
  // `month` in 1-index). Result already honours leap years.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isIsoDate(s: string): boolean {
  const m = ISO_DATE_REGEX.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function isValidBody(body: unknown): body is ScrapeReservationListBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeReservationListBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (
    b.mode !== 'initial' &&
    b.mode !== 'incremental' &&
    b.mode !== 'full'
  ) {
    return false;
  }
  if (typeof b.window_start !== 'string' || !isIsoDate(b.window_start)) return false;
  if (typeof b.window_end !== 'string' || !isIsoDate(b.window_end)) return false;
  if (b.window_end < b.window_start) return false;
  if (b.cursor !== undefined && b.cursor !== null && typeof b.cursor !== 'string') return false;
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

    // Auth-epoch gate. Two distinct states are blocked here:
    //
    //   counter > 0 && !ready  - /inject-cookies is mid-flight, has bumped the
    //                            counter, has NOT yet verified the post-reload
    //                            URL. Cookies may be in a half-rotated state.
    //                            Fail closed with 409 auth_epoch_not_ready.
    //   counter = 0 && !ready  - Fresh process state (Fly machine boot, no
    //                            /inject-cookies has run yet). The persistent
    //                            profile on /data/profile is authoritative;
    //                            trust it like /sync does. Worker/provisioner
    //                            saga is responsible for running /inject-cookies
    //                            during onboarding so this state is short-lived.
    //   counter > 0 && ready   - Healthy steady state. Serve.
    //
    // The non-zero-counter requirement is the load-bearing distinction: it
    // prevents serving while a rotation is mid-flight, but lets a freshly
    // booted machine with a populated profile serve immediately, matching the
    // /sync endpoint's behaviour rather than introducing an asymmetric
    // restart contract that the worker would have to special-case.
    const counterAtStart = currentAuthEpoch();
    if (counterAtStart > 0 && !isAuthEpochReady()) {
      return res.status(409).json({ error: 'auth_epoch_not_ready' });
    }
    const epochAtStart = counterAtStart;

    let ctx;
    try {
      ctx = await getBrowserContext({ profileDir: env.PROFILE_DIR });
    } catch (err) {
      // A concurrent rotation can close an in-flight context launch; surface
      // as retryable 409 instead of masking as 500 browser_failed.
      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }
      return res.status(500).json({
        error: 'browser_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Re-check epoch after getBrowserContext: a concurrent /inject-cookies could
    // have started rotating between the initial gate and now, in which case any
    // cookies we observe past this point may be a half-rotated mix. Surface as
    // a retryable 409 rather than letting the call proceed into a partial scrape.
    if (currentAuthEpoch() !== epochAtStart) {
      return res.status(409).json({ error: 'auth_epoch_changed' });
    }

    let sessionOk: boolean;
    try {
      sessionOk = await readAirbnbSessionStrict(ctx);
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

    // Re-check epoch after a TRUE session result: the cookies we just observed
    // could have been the in-flight mid-rotation set. If the epoch shifted, the
    // session validity we just confirmed is potentially stale — fail closed
    // with 409 rather than starting a scrape against a half-rotated context.
    if (currentAuthEpoch() !== epochAtStart) {
      return res.status(409).json({ error: 'auth_epoch_changed' });
    }

    try {
      const result = await scrapeReservationList(ctx, {
        mode: req.body.mode,
        window_start: req.body.window_start,
        window_end: req.body.window_end,
        cursor: req.body.cursor ?? null,
        apiKey: env.AIRBNB_API_KEY,
        cursorSecret: env.HMAC_SECRET,
      });

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }

      return res.status(200).json({
        schema_version: result.schema_version,
        mode: result.mode,
        window_start: result.window_start,
        window_end: result.window_end,
        page_cursor: result.page_cursor,
        next_page_cursor: result.next_page_cursor,
        page_index: result.page_index,
        is_complete: result.is_complete,
        scraped_at: result.scraped_at,
        reservations: result.reservations,
        diagnostics: result.diagnostics,
      });
    } catch (err) {
      // Mid-scrape rotation typically closes the browser context, surfacing as
      // a Playwright `Target closed` throw. Re-check the epoch so the worker
      // sees 409 (retryable) rather than 500 (treated as hard failure).
      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(409).json({ error: 'auth_epoch_changed' });
      }
      if (err instanceof ReservationListCursorError) {
        return res.status(400).json({ error: 'malformed_cursor' });
      }
      return res.status(500).json({
        error: 'scrape_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
