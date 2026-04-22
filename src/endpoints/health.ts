/**
 * GET /health — Fly health checker + staysync-app playwright-health-monitor cron.
 * Spec §2.5 step 1:
 *   Response: { status: 'ok' | 'degraded', uptime_s, memory_mb, cookie_valid, last_airbnb_request_at }
 *
 * No HMAC auth — the Fly internal health checker (and private-network monitors) hit this
 * endpoint repeatedly on a short interval. Guarded by 6PN private networking at the infra level.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { getBrowserContext, getLastAirbnbRequestAt, hasAirbnbSession } from '../playwright/browser';

export function healthHandler(env: MachineEnv) {
  return async (_req: Request, res: Response) => {
    const memBytes = process.memoryUsage.rss();
    const memMb = Math.round(memBytes / (1024 * 1024));
    const uptime = Math.round(process.uptime());

    let cookieValid = false;
    let browserOk = false;
    try {
      const ctx = await getBrowserContext({ profileDir: env.PROFILE_DIR });
      cookieValid = await hasAirbnbSession(ctx);
      browserOk = true;
    } catch {
      browserOk = false;
    }

    const status = browserOk && cookieValid ? 'ok' : 'degraded';
    const last = getLastAirbnbRequestAt();

    res.status(200).json({
      status,
      uptime_s: uptime,
      memory_mb: memMb,
      cookie_valid: cookieValid,
      last_airbnb_request_at: last ? last.toISOString() : null,
    });
  };
}
