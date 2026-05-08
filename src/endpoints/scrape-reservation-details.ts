/**
 * POST /scrape-reservation-details — HMAC-authed.
 *
 * Enriches source-of-truth reservation rows with Airbnb's reservation-details
 * payment breakdown. This endpoint reuses the persistent browser context and
 * the same auth-epoch safety gate as /scrape-reservation-list.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import { scrapeReservationDetails } from '../playwright/scrape-reservation-details';

interface ScrapeReservationDetailsBody {
  host_id: string;
  confirmation_codes: string[];
}

const CONF_CODE_RE = /^HM[A-Z0-9-]{6,}$/i;
const MAX_DETAIL_CODES = 25;

function isValidBody(body: unknown): body is ScrapeReservationDetailsBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<ScrapeReservationDetailsBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (!Array.isArray(b.confirmation_codes)) return false;
  if (b.confirmation_codes.length < 1 || b.confirmation_codes.length > MAX_DETAIL_CODES) return false;
  const normalized = new Set<string>();
  for (const code of b.confirmation_codes) {
    if (typeof code !== 'string') return false;
    const normalizedCode = code.trim().toUpperCase();
    if (!CONF_CODE_RE.test(normalizedCode)) return false;
    if (normalized.has(normalizedCode)) return false;
    normalized.add(normalizedCode);
  }
  return true;
}

function isAirbnbAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /^reservation_detail_api_failed:(401|403)$/.test(message);
}

export function scrapeReservationDetailsHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
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
      const result = await scrapeReservationDetails(ctx, {
        confirmation_codes: req.body.confirmation_codes,
        apiKey: env.AIRBNB_API_KEY,
      });

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(503).json({ error: 'auth_epoch_changed' });
      }

      return res.status(200).json(result);
    } catch (err) {
      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(503).json({ error: 'auth_epoch_changed' });
      }
      if (isAirbnbAuthFailure(err)) {
        return res.status(401).json({ error: 'invalid_cookies' });
      }
      return res.status(500).json({
        error: 'scrape_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export const __scrapeReservationDetailsEndpointTestHooks = {
  MAX_DETAIL_CODES,
  isAirbnbAuthFailure,
  isValidBody,
};
