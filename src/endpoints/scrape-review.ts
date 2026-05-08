/**
 * POST /scrape-review — HMAC-authed.
 *
 * Recovers full Airbnb public review text from the anchored review detail page.
 * This endpoint is direct-anchor only: callers must provide review_url or
 * confirmation_code. No general reviews-list search happens here.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import {
  ScrapeReviewError,
  scrapeReviewText,
  isSentinelGuestName,
  isValidAirbnbReviewUrl,
} from '../playwright/scrape-review';

interface ScrapeReviewBody {
  host_id: string;
  guest_name: string;
  review_url?: string | null;
  confirmation_code?: string | null;
  property_name?: string | null;
}

const CONF_CODE_RE = /^HM[A-Z0-9-]{6,}$/i;

function isValidBody(body: unknown): body is ScrapeReviewBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeReviewBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (typeof b.guest_name !== 'string' || b.guest_name.trim().length === 0) return false;

  const reviewUrl = b.review_url?.trim();
  const confirmationCode = b.confirmation_code?.trim();
  if (!reviewUrl && !confirmationCode) return false;
  if (reviewUrl && !isValidAirbnbReviewUrl(reviewUrl)) return false;
  if (confirmationCode && !CONF_CODE_RE.test(confirmationCode)) return false;
  if (b.property_name !== undefined && b.property_name !== null && typeof b.property_name !== 'string') {
    return false;
  }
  return true;
}

function statusForScrapeError(error: ScrapeReviewError): number {
  switch (error.code) {
    case 'malformed_body':
    case 'invalid_review_url':
    case 'invalid_confirmation_code':
    case 'sentinel_guest_name':
      return 400;
    case 'review_not_found':
    case 'reservation_not_found':
      return 404;
    case 'no_text':
      return 400;
    case 'invalid_cookies':
      return 401;
    case 'identity_mismatch':
      return 409;
  }
}

export function scrapeReviewHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    if (isSentinelGuestName(req.body.guest_name)) {
      return res.status(400).json({
        error: 'sentinel_guest_name',
        message: 'sentinel_guest_name',
      });
    }

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
      const result = await scrapeReviewText(ctx, {
        guest_name: req.body.guest_name,
        review_url: req.body.review_url ?? null,
        confirmation_code: req.body.confirmation_code ?? null,
        property_name: req.body.property_name ?? null,
      });

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(503).json({ error: 'auth_epoch_changed' });
      }

      return res.status(200).json(result);
    } catch (err) {
      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(503).json({ error: 'auth_epoch_changed' });
      }
      if (err instanceof ScrapeReviewError) {
        return res.status(statusForScrapeError(err)).json({
          error: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'scrape_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export const __scrapeReviewEndpointTestHooks = {
  CONF_CODE_RE,
  isValidBody,
  statusForScrapeError,
};
