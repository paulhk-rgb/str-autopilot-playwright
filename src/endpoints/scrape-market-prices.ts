/**
 * POST /scrape-market-prices — HMAC-authed read-only market scrape.
 *
 * The worker reads Airbnb/Booking market pages from host-provided market config.
 * It does not write prices, mutate Airbnb, or source any Paul-specific defaults.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import {
  acquireSingleFlightWithWait,
  getSingleFlightSnapshot,
  type SingleFlightLease,
} from '../lib/single-flight';
import { completeScrapeJob, createScrapeJob, failScrapeJob, getScrapeJob } from '../lib/scrape-jobs';
import type { BrowserContext } from 'playwright';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import {
  MarketScrapeError,
  normalizeMarketConfig,
  scrapeMarketPrices,
  type MarketScrapeConfig,
} from '../playwright/scrape-market-prices';

// How long a market scrape will wait for the shared machine lock before 409ing.
// Bounded well under the app-side per-chunk request timeout (280s) so the wait
// plus the chunk's own scrape still returns within the caller's deadline.
// Overridable via env (tests shrink it; ops can tune contention behaviour).
const DEFAULT_MARKET_LOCK_WAIT_MS = 30_000;

function marketLockWaitMs(): number {
  const raw = Number(process.env.MARKET_LOCK_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MARKET_LOCK_WAIT_MS;
}

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

function marketSingleFlightOperation(
  body: ScrapeMarketPricesBody,
  market = normalizeMarketConfig(body.market),
): string {
  const datesKey = market.target_dates?.length
    ? market.target_dates.join(',')
    : `horizon:${market.horizon_days}`;
  const nightKey = market.night_counts.join(',');
  const bedroomKey = market.bedroom_counts.join(',');
  const locationKey = market.location.trim().toLowerCase();
  return `scrape-market-prices:${body.host_id}:${locationKey}:dates:${datesKey}:nights:${nightKey}:bedrooms:${bedroomKey}`;
}

/** Runs the market scrape in the background for an async job, then releases
 * the single-flight lease. Mirrors the synchronous path's auth-epoch + error
 * mapping, but reports outcomes into the job registry instead of an HTTP body. */
async function runMarketScrapeJob(args: {
  jobId: string;
  ctx: BrowserContext;
  market: MarketScrapeConfig;
  epochAtStart: number;
  lease: SingleFlightLease;
}): Promise<void> {
  const { jobId, ctx, market, epochAtStart, lease } = args;
  try {
    const result = await scrapeMarketPrices(ctx, { market });
    if (currentAuthEpoch() !== epochAtStart) {
      failScrapeJob(jobId, 'auth_epoch_changed');
      return;
    }
    completeScrapeJob(jobId, result);
  } catch (err) {
    if (currentAuthEpoch() !== epochAtStart) {
      failScrapeJob(jobId, 'auth_epoch_changed');
      return;
    }
    if (err instanceof MarketScrapeError) {
      failScrapeJob(jobId, err.code);
      return;
    }
    failScrapeJob(jobId, err instanceof Error ? err.message : String(err));
  } finally {
    lease.release();
  }
}

interface ScrapeMarketStatusBody {
  host_id: string;
  job_id: string;
}

function isValidStatusBody(body: unknown): body is ScrapeMarketStatusBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeMarketStatusBody>;
  return (
    typeof b.host_id === 'string' && b.host_id.length > 0 &&
    typeof b.job_id === 'string' && b.job_id.length > 0
  );
}

/**
 * GET-style status poll for an async market scrape job (HMAC-authed POST so the
 * existing signing middleware covers it). Always 200 for a known job so the
 * caller branches on the `status` field; 404 only when the job id is unknown
 * (GC'd or never created).
 */
export function scrapeMarketStatusHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidStatusBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }
    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }
    const job = getScrapeJob(req.body.job_id);
    if (!job) {
      return res.status(404).json({ error: 'job_not_found' });
    }
    if (job.status === 'running') {
      return res.status(200).json({ status: 'running' });
    }
    if (job.status === 'failed') {
      return res.status(200).json({ status: 'failed', error: job.error });
    }
    return res.status(200).json({ status: 'complete', result: job.result });
  };
}

export function scrapeMarketPricesHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    const market = normalizeMarketConfig(req.body.market);
    // Wait (bounded) for the shared single-flight lock instead of 409-ing
    // immediately. The machine runs one browser; a market scrape and a message
    // sync contend for it. Yielding for up to MARKET_LOCK_WAIT_MS lets a short
    // in-flight op (e.g. an inbox sync) finish first, so the common collision
    // resolves without a client-side retry. A still-held lock past the wait
    // returns 409 as before (the app chunks scrapes and retries that chunk).
    const lease = await acquireSingleFlightWithWait(
      marketSingleFlightOperation(req.body, market),
      { maxWaitMs: marketLockWaitMs() },
    );
    if (!lease) {
      return res.status(409).json({
        error: 'scrape_already_running',
        single_flight: getSingleFlightSnapshot(),
      });
    }

    let scrapeStarted = false;
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

      // Session is good. Run the (long) scrape in the BACKGROUND and return a
      // job id immediately — the caller polls /scrape-market-status. Keeping the
      // request short means the caller's serverless function budget is never the
      // scrape's deadline (the old synchronous hold orphaned the lock when the
      // caller timed out → 409 retry storms). The single-flight lease is held
      // until the background scrape finishes (released in runMarketScrapeJob).
      const jobId = randomUUID();
      createScrapeJob(jobId);
      scrapeStarted = true;
      void runMarketScrapeJob({ jobId, ctx, market, epochAtStart, lease });
      return res.status(202).json({ job_id: jobId, status: 'running' });
    } finally {
      // Release here ONLY on a pre-scrape failure; once the background scrape
      // owns the lease it releases it on completion.
      if (!scrapeStarted) lease.release();
    }
  };
}

export const __scrapeMarketPricesEndpointTestHooks = {
  isValidBody,
  marketSingleFlightOperation,
  statusForMarketScrapeError,
};
