/**
 * POST /scrape-market-prices — HMAC-authed read-only market scrape.
 *
 * The worker reads Airbnb/Booking market pages from host-provided market config.
 * It does not write prices, mutate Airbnb, or source any Paul-specific defaults.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { tryAcquireSingleFlight } from '../lib/single-flight';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import {
  MarketScrapeError,
  normalizeMarketConfig,
  scrapeMarketPrices,
  type MarketScrapeConfig,
} from '../playwright/scrape-market-prices';

interface ScrapeMarketPricesBody {
  host_id: string;
  property_id: string;
  market: MarketScrapeConfig;
  dry_run?: boolean;
}

function isValidBody(body: unknown): body is ScrapeMarketPricesBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeMarketPricesBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (typeof b.property_id !== 'string' || b.property_id.length === 0) return false;
  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') return false;
  try {
    normalizeMarketConfig(b.market);
  } catch {
    return false;
  }
  return true;
}

function statusForMarketScrapeError(error: MarketScrapeError): number {
  switch (error.code) {
    case 'blocked_by_airbnb':
      return 429;
    case 'no_dates_scraped':
      return 502;
  }
}

export function scrapeMarketPricesHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    const lease = tryAcquireSingleFlight(`scrape-market-prices:${req.body.property_id}`);
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
        const result = await scrapeMarketPrices(ctx, {
          market: normalizeMarketConfig(req.body.market),
        });

        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }

        return res.status(200).json(result);
      } catch (err) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        if (err instanceof MarketScrapeError) {
          return res.status(statusForMarketScrapeError(err)).json({
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

export const __scrapeMarketPricesEndpointTestHooks = {
  isValidBody,
  statusForMarketScrapeError,
};
