/**
 * POST /set-prices — HMAC-authed live Airbnb price write endpoint.
 *
 * This file currently owns the production safety contract and request validation.
 * The browser mutation path is intentionally fail-closed until the setter is implemented.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { tryAcquireSingleFlight } from '../lib/single-flight';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';
import { getBrowserContext, readAirbnbSessionStrict } from '../playwright/browser';
import {
  BrowserSetPricesError,
  setCalendarPrices,
} from '../playwright/set-prices';

type PriceApplyReasonCode =
  | 'duplicate_date'
  | 'blocked_by_airbnb'
  | 'host_id_mismatch'
  | 'invalid_cookies'
  | 'invalid_value'
  | 'listing_mismatch'
  | 'malformed_body'
  | 'no_dates_found'
  | 'pricing_write_not_implemented'
  | 'request_too_large'
  | 'unsupported_currency';

interface PriceBounds {
  min: number;
  max: number;
  currency: string;
}

export interface SetPricesDateRequest {
  date: string;
  plan_id: string;
  plan_version: number;
  price: number;
}

export interface SetPricesBody {
  schema_version: 1;
  host_id: string;
  property_id: string;
  listing_id: string;
  currency: string;
  idempotency_key: string;
  dry_run: boolean;
  price_bounds: PriceBounds;
  dates: SetPricesDateRequest[];
}

interface ValidationResult {
  ok: boolean;
  reason?: PriceApplyReasonCode;
}

const MAX_WRITE_DATES = 14;
const MAX_ABSOLUTE_NIGHTLY_PRICE = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  return date.toISOString().slice(0, 10) === value;
}

function isValidCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

function isValidPriceBounds(bounds: unknown, currency: string): bounds is PriceBounds {
  if (!isRecord(bounds)) return false;
  const min = bounds.min;
  const max = bounds.max;
  if (bounds.currency !== currency) return false;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return false;
  if (typeof min !== 'number' || typeof max !== 'number') return false;
  if (min < 1 || max < min || max > MAX_ABSOLUTE_NIGHTLY_PRICE) return false;
  return true;
}

function validateDates(dates: unknown, bounds: PriceBounds): ValidationResult {
  if (!Array.isArray(dates) || dates.length === 0) {
    return { ok: false, reason: 'malformed_body' };
  }
  if (dates.length > MAX_WRITE_DATES) {
    return { ok: false, reason: 'request_too_large' };
  }

  const seenDates = new Set<string>();
  for (const entry of dates) {
    if (!isRecord(entry)) return { ok: false, reason: 'malformed_body' };
    if (typeof entry.date !== 'string' || !isIsoDate(entry.date)) {
      return { ok: false, reason: 'malformed_body' };
    }
    if (seenDates.has(entry.date)) {
      return { ok: false, reason: 'duplicate_date' };
    }
    seenDates.add(entry.date);

    if (typeof entry.plan_id !== 'string' || entry.plan_id.trim() === '') {
      return { ok: false, reason: 'malformed_body' };
    }
    const planVersion = entry.plan_version;
    if (!Number.isInteger(planVersion) || typeof planVersion !== 'number' || planVersion < 1) {
      return { ok: false, reason: 'malformed_body' };
    }
    const price = entry.price;
    if (
      !Number.isInteger(price) ||
      typeof price !== 'number' ||
      price < bounds.min ||
      price > bounds.max ||
      price > MAX_ABSOLUTE_NIGHTLY_PRICE
    ) {
      return { ok: false, reason: 'invalid_value' };
    }
  }

  return { ok: true };
}

function validateSetPricesBody(body: unknown): ValidationResult {
  if (!isRecord(body)) return { ok: false, reason: 'malformed_body' };
  if (body.schema_version !== 1) return { ok: false, reason: 'malformed_body' };
  if (typeof body.host_id !== 'string' || body.host_id.trim() === '') return { ok: false, reason: 'malformed_body' };
  if (typeof body.property_id !== 'string' || body.property_id.trim() === '') return { ok: false, reason: 'malformed_body' };
  if (typeof body.listing_id !== 'string' || !/^\d+$/.test(body.listing_id.trim())) return { ok: false, reason: 'malformed_body' };
  if (typeof body.currency !== 'string' || !isValidCurrency(body.currency)) return { ok: false, reason: 'unsupported_currency' };
  if (typeof body.idempotency_key !== 'string' || body.idempotency_key.trim().length < 16) {
    return { ok: false, reason: 'malformed_body' };
  }
  if (typeof body.dry_run !== 'boolean') return { ok: false, reason: 'malformed_body' };
  if (!isValidPriceBounds(body.price_bounds, body.currency)) {
    return { ok: false, reason: 'unsupported_currency' };
  }
  return validateDates(body.dates, body.price_bounds);
}

function isPricingBrowserSetPricesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STAYSYNC_PRICING_BROWSER_SET_PRICES_ENABLED === 'true';
}

function allowSmartPricingToggle(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STAYSYNC_PRICING_ALLOW_SMART_PRICING_TOGGLE === 'true';
}

function statusForSetPricesError(error: BrowserSetPricesError): number {
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

export function setPricesHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    const validation = validateSetPricesBody(req.body);
    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        schema_version: 1,
        error: validation.reason ?? 'malformed_body',
        reason: validation.reason ?? 'malformed_body',
      });
    }

    const body = req.body as SetPricesBody;
    if (body.host_id !== env.HOST_ID) {
      return res.status(403).json({
        success: false,
        schema_version: 1,
        error: 'host_id_mismatch',
        reason: 'host_id_mismatch',
      });
    }

    if (!isPricingBrowserSetPricesEnabled()) {
      return res.status(501).json(failClosedNotImplementedResponse(body));
    }

    const counterAtStart = currentAuthEpoch();
    if (counterAtStart > 0 && !isAuthEpochReady()) {
      return res.status(503).json({ error: 'auth_epoch_not_ready' });
    }
    const epochAtStart = counterAtStart;

    const lease = tryAcquireSingleFlight(`set-prices:${body.listing_id}`);
    if (!lease) {
      return res.status(409).json({ error: 'already_running', reason: 'already_running' });
    }

    try {
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
        return res.status(401).json({ error: 'invalid_cookies', reason: 'invalid_cookies' });
      }

      if (currentAuthEpoch() !== epochAtStart) {
        return res.status(503).json({ error: 'auth_epoch_changed' });
      }

      try {
        const result = await setCalendarPrices(ctx, {
          request: body,
          allowSmartPricingToggle: allowSmartPricingToggle(),
        });

        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }

        return res.status(200).json(result);
      } catch (err) {
        if (currentAuthEpoch() !== epochAtStart) {
          return res.status(503).json({ error: 'auth_epoch_changed' });
        }
        if (err instanceof BrowserSetPricesError) {
          return res.status(statusForSetPricesError(err)).json({
            success: false,
            schema_version: 1,
            host_id: body.host_id,
            listing_id: body.listing_id,
            currency: body.currency,
            dry_run: body.dry_run,
            session_listing_verified: false,
            smart_pricing_enabled: false,
            error: err.code,
            reason: err.code,
            results: body.dates.map((date) => ({
              date: date.date,
              status: 'failed',
              verified: false,
              requested_price: date.price,
              currency: body.currency,
              reason: err.code,
            })),
          });
        }
        return res.status(500).json({
          error: 'set_prices_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      lease.release();
    }
  };
}

function failClosedNotImplementedResponse(body: SetPricesBody) {
  return {
    success: false,
    schema_version: 1,
    host_id: body.host_id,
    listing_id: body.listing_id,
    currency: body.currency,
    dry_run: body.dry_run,
    session_listing_verified: false,
    smart_pricing_enabled: false,
    error: 'pricing_write_not_implemented',
    reason: 'pricing_write_not_implemented' satisfies PriceApplyReasonCode,
    results: body.dates.map((date) => ({
      date: date.date,
      status: 'failed',
      verified: false,
      requested_price: date.price,
      currency: body.currency,
      reason: 'pricing_write_not_implemented' satisfies PriceApplyReasonCode,
    })),
  };
}

export const __setPricesEndpointTestHooks = {
  MAX_ABSOLUTE_NIGHTLY_PRICE,
  MAX_WRITE_DATES,
  allowSmartPricingToggle,
  failClosedNotImplementedResponse,
  isPricingBrowserSetPricesEnabled,
  statusForSetPricesError,
  validateSetPricesBody,
};
