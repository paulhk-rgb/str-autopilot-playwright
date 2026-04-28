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
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
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
 * Permissive ISO8601 / RFC3339 date-time timestamp check.
 *
 * Accepts the canonical Z-suffixed form emitted by JS `Date#toISOString()`
 * (e.g. `2026-04-01T00:00:00.000Z`) PLUS the equally valid forms callers
 * outside JS routinely produce: no fractional seconds (`2026-04-01T00:00:00Z`),
 * numeric offsets (`2026-04-01T00:00:00+00:00`), and 1-6 digit fractional
 * seconds.
 *
 * Rejects:
 *   - ambiguous/locale-dependent inputs (`2026-04-28 10:30:00`, `04/28/2026`)
 *   - date-only forms (`2026-04-01`) — contract is date-time, not date
 *   - invalid calendar dates (`2026-02-31T00:00:00Z`,
 *     `2026-02-31T00:00:00-05:00`) — `Date.parse` silently auto-corrects
 *     day-overflows that stay within ISO 31-max (e.g. Feb 31 → Mar 3)
 *     regardless of offset, so we validate Y/M/D at the component level
 *     before relying on `Date.parse`. This works uniformly across all
 *     offset variants because it inspects the wall-clock components from
 *     the input, not the UTC-normalized result.
 *
 * `Date.parse` already rejects month > 12 and day > 31 at the lexical level
 * (returns NaN), so the component check focuses on day-vs-days-in-month.
 */
const ISO8601_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  // `Date.UTC(year, month, 0)` rolls back to the last day of the prior month.
  // Pass `month` as the 1-indexed input value (the API treats it as 0-indexed
  // + advance by `0`, which equals the last day of `month - 1` in 0-index =
  // `month` in 1-index). Result already honours leap years.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isIso8601(s: string): boolean {
  const m = ISO8601_REGEX.exec(s);
  if (!m) return false;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return false;
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
