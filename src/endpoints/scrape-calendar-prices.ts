/**
 * POST /scrape-calendar-prices — HMAC-authed read-only host calendar scrape.
 *
 * This endpoint observes Airbnb's host calendar for a listing/date range. It never mutates
 * prices, minimum stays, availability, or smart-pricing state.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { tryAcquireSingleFlight } from '../lib/single-flight';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import {
  CalendarPriceScrapeError,
  normalizeCalendarPriceRequest,
  scrapeCalendarPrices,
  type CalendarPriceScrapeRequest,
} from '../playwright/scrape-calendar-prices';

interface ScrapeCalendarPricesBody {
  host_id: string;
  property_id?: string;
  listing_id: string;
  start_date: string;
  end_date: string;
  currency?: string;
  dry_run?: boolean;
}

function isValidBody(body: unknown): body is ScrapeCalendarPricesBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeCalendarPricesBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (b.property_id !== undefined && typeof b.property_id !== 'string') return false;
  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') return false;
  try {
    normalizeCalendarPriceRequest(toCalendarRequest(b));
  } catch {
    return false;
  }
  return true;
}

function toCalendarRequest(body: Partial<ScrapeCalendarPricesBody>): CalendarPriceScrapeRequest {
  return {
    listing_id: body.listing_id ?? '',
    start_date: body.start_date ?? '',
    end_date: body.end_date ?? '',
    currency: body.currency,
  };
}

function statusForCalendarPriceScrapeError(error: CalendarPriceScrapeError): number {
  switch (error.code) {
    case 'blocked_by_airbnb':
      return 429;
    case 'invalid_cookies':
      return 401;
    case 'listing_mismatch':
      return 403;
    case 'no_dates_found':
      return 502;
  }
}

export function scrapeCalendarPricesHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    const request = normalizeCalendarPriceRequest(toCalendarRequest(req.body));
    const lockKey = `scrape-calendar-prices:${req.body.property_id ?? request.listing_id}`;
    const lease = tryAcquireSingleFlight(lockKey);
    if (!lease) {
      return res.status(409).json({ error: 'scrape_already_running' });
    }

    try {
      const counterAtStart = currentAuthEpoch();
      if (counterAtStart > 0 && !isAuthEpochReady()) {
        return res.status(503).json({ error: 'auth_epoch_not_ready' });
      }
      const epochAtStart = counterAtStart;

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
        const result = await scrapeCalendarPrices(ctx, { request });

        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }

        return res.status(200).json(result);
      } catch (err) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        if (err instanceof CalendarPriceScrapeError) {
          return res.status(statusForCalendarPriceScrapeError(err)).json({
            error: err.code,
            message: err.message,
          });
        }
        return res.status(500).json({
          error: 'scrape_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      lease.release();
    }
  };
}

export const __scrapeCalendarPricesEndpointTestHooks = {
  isValidBody,
  statusForCalendarPriceScrapeError,
  toCalendarRequest,
};
