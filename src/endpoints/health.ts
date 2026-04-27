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
import {
  getBrowserContext,
  getLastAirbnbRequestAt,
  getSpaListener,
  hasAirbnbSession,
} from '../playwright/browser';
import { currentAuthEpoch, isAuthEpochReady } from '../playwright/auth-epoch';

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

    // v0.3 spec §5: surface api-reader diagnostics for the pull-path alerting
    // channel. /health-check cron polls this and flags hash drift.
    //
    // hash_rotation_stuck: TRUE when no SPA observation in the last 10 minutes
    // (i.e., the listener has never seen a Viaduct GraphQL request, OR the
    // last one was too long ago to reflect current state). This is the actual
    // "stuck" signal — Sonnet v0.3 audit B3 noted the previous flag (env hash
    // != observed hash) was inverted: observed-different-than-env is NORMAL
    // during auto-recovery, not a failure mode.
    const spa = getSpaListener();
    const obs = spa.observation();
    const STALE_OBSERVATION_MS = 10 * 60 * 1000;
    const observationAgeMs =
      obs.lastObservedAtMs !== null ? Date.now() - obs.lastObservedAtMs : null;
    const hashRotationStuck =
      observationAgeMs === null || observationAgeMs > STALE_OBSERVATION_MS;
    const apiReader = {
      mode: env.INBOX_READER_MODE,
      auth_epoch: currentAuthEpoch(),
      auth_epoch_ready: isAuthEpochReady(),
      last_observed_inbox_hash: obs.inboxHash,
      last_observed_thread_hash: obs.threadHash,
      last_observed_client_version: obs.clientVersion,
      last_observed_at_ms: obs.lastObservedAtMs,
      observation_age_ms: observationAgeMs,
      configured_inbox_hash: env.AIRBNB_API_INBOX_HASH,
      configured_thread_hash: env.AIRBNB_API_THREAD_HASH,
      // Drift indicators — both hashes; cron compares against expected.
      inbox_hash_drift:
        obs.inboxHash !== null && obs.inboxHash !== env.AIRBNB_API_INBOX_HASH,
      thread_hash_drift:
        obs.threadHash !== null && obs.threadHash !== env.AIRBNB_API_THREAD_HASH,
      hash_rotation_stuck: hashRotationStuck,
    };

    res.status(200).json({
      status,
      uptime_s: uptime,
      memory_mb: memMb,
      cookie_valid: cookieValid,
      last_airbnb_request_at: last ? last.toISOString() : null,
      api_reader: apiReader,
    });
  };
}
