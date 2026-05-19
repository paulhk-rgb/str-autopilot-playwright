/**
 * POST /scrape-listing-editor — HMAC-authed.
 *
 * Captures text/field snapshots from the authenticated Airbnb host listing
 * editor. The StaySync app owns DB writes and KB import; this worker only reads
 * pages from the per-host persistent browser session.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { tryAcquireSingleFlight } from '../lib/single-flight';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import {
  ListingEditorScrapeError,
  normalizeListingId,
  normalizeRequestedPaths,
  scrapeListingEditor,
} from '../playwright/scrape-listing-editor';

interface ScrapeListingEditorBody {
  host_id: string;
  listing_id: string;
  paths?: string[];
}

function isValidBody(body: unknown): body is ScrapeListingEditorBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeListingEditorBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (typeof b.listing_id !== 'string') return false;
  try {
    normalizeListingId(b.listing_id);
    normalizeRequestedPaths(b.paths);
  } catch {
    return false;
  }
  return true;
}

function statusForListingEditorError(error: ListingEditorScrapeError): number {
  switch (error.code) {
    case 'listing_id_mismatch':
      return 409;
    case 'no_pages_scraped':
      return 502;
  }
}

export function scrapeListingEditorHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    const lease = tryAcquireSingleFlight('scrape-listing-editor');
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
        const result = await scrapeListingEditor(ctx, {
          listing_id: req.body.listing_id,
          paths: req.body.paths,
        });

        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }

        return res.status(200).json(result);
      } catch (err) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        if (err instanceof ListingEditorScrapeError) {
          return res.status(statusForListingEditorError(err)).json({
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

export const __scrapeListingEditorEndpointTestHooks = {
  isValidBody,
  statusForListingEditorError,
};
