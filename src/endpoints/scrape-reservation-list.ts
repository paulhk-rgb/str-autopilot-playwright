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
 * Response:
 *   { reservations: Reservation[], scraped_at: ISO8601, account_email: string }
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
import { getBrowserContext, markAirbnbRequest } from '../playwright/browser';
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
  if (b.since !== undefined && typeof b.since !== 'string') return false;
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

    markAirbnbRequest();

    try {
      const result = await scrapeReservationList(ctx, {
        mode: req.body.mode ?? 'incremental',
        since: req.body.since,
      });

      return res.status(200).json({
        reservations: result.reservations,
        scraped_at: result.scrapedAt,
        account_email: result.accountEmail,
      });
    } catch (err) {
      return res.status(500).json({
        error: 'scrape_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
