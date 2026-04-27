/**
 * POST /sync — HMAC-authed.
 * Spec §2.4 step 5 + §2.7.
 *
 * Request body:
 *   { host_id: string, mode: 'initial' | 'incremental' | 'full', since?: ISO8601 }
 *
 * Response (sync, AFTER all batches posted):
 *   { messages_found: number, bookings_found: number, errors: string[] }
 *
 * Callback pagination (spec §2.7 "Message delivery during sync"):
 *   POST ${CALLBACK_URL} with body:
 *     {
 *       action: "sync_messages_batch",
 *       host_id,
 *       payload: { messages: [...max 50...], page: number (1-indexed), has_more: boolean }
 *     }
 *   Keep POSTing until has_more === false, then return the summary synchronously.
 *
 * NOTE: This PR ships the endpoint + callback plumbing but uses a STUB scraper.
 * Real Airbnb inbox scraping (DOM selectors, infinite scroll, pagination) is a follow-up:
 * the inbox DOM is stable enough in the sibling GAS project to crib from when wiring the
 * real scraper in PR 3+. Keeping PR 2 focused on: HMAC, endpoint contract, callback shape,
 * and the 50-msg batching behaviour spec §2.7 mandates.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { postCallback } from '../lib/callback';
import {
  ensureSpaListenerOnPage,
  getBrowserContext,
  markAirbnbRequest,
} from '../playwright/browser';
import { scrapeInbox, type ScrapedMessage } from '../playwright/scrape-inbox';
import { runApiReaderCycle } from '../playwright/api-reader-cycle';
import { WatermarkStore } from '../playwright/watermark-store';

interface SyncBody {
  host_id: string;
  mode: 'initial' | 'incremental' | 'full';
  since?: string;
  // Display name shown on the host's Airbnb profile — used to classify each
  // scraped message as 'host' vs 'guest' from the aria-label "<Name> sent ..."
  // pattern. Optional for back-compat; without it, every non-system message
  // defaults to 'guest' and the saga must reclassify host messages downstream.
  host_display_name?: string;
}

const MAX_BATCH_SIZE = 50;

function isValidSyncBody(body: unknown): body is SyncBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<SyncBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (b.mode !== 'initial' && b.mode !== 'incremental' && b.mode !== 'full') return false;
  if (b.since !== undefined && typeof b.since !== 'string') return false;
  if (b.host_display_name !== undefined && typeof b.host_display_name !== 'string') return false;
  return true;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function syncHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidSyncBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    // Machine HOST_ID is the source of truth (HMAC already bound it). Guard against mismatch.
    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    // Ensure the browser is up — spec §2.5 step 1 relies on this for cookie validity too.
    let ctx;
    try {
      ctx = await getBrowserContext({ profileDir: env.PROFILE_DIR });
    } catch (err) {
      return res.status(500).json({
        messages_found: 0,
        bookings_found: 0,
        errors: ['browser_failed: ' + (err instanceof Error ? err.message : String(err))],
      });
    }

    markAirbnbRequest();

    // v0.3 wiring — dispatch by INBOX_READER_MODE.
    // - 'ui'     : existing UI scraper is sole emitter (production default).
    // - 'shadow' : run UI scraper as emitter; run API cycle as observer; emit
    //              API diagnostics to side channel only (logs / health).
    // - 'api'    : API cycle is sole emitter; UI scraper not invoked. Promote
    //              ONLY after shadow mode shows ≥3 days of 0 mismatches per
    //              spec §10 v0.4.
    let messages: ScrapedMessage[] = [];
    let bookingsFound = 0;
    const errors: string[] = [];
    let apiDiag: unknown = null;
    // commitWatermarks is invoked AFTER all callback batches return 2xx (api
    // mode only). No-op in ui/shadow modes. Spec §4 step 6 + audit B2.
    let commitWatermarks: () => void = () => undefined;

    if (env.INBOX_READER_MODE === 'ui') {
      const uiResult = await scrapeInbox(ctx, {
        mode: req.body.mode,
        since: req.body.since,
        hostDisplayName: req.body.host_display_name,
      });
      messages = uiResult.messages;
      bookingsFound = uiResult.bookingsFound;
      errors.push(...uiResult.errors);
    } else if (env.INBOX_READER_MODE === 'shadow') {
      // Run UI THEN API sequentially to avoid execution-context collisions
      // on the shared page (Gemini v0.3 audit: parallel runs trip Playwright
      // when UI scraper navigates between threads). UI remains sole callback
      // emitter; API output lives in diag/log only. v0.4 wiring will add the
      // proper UI→API batch handoff for the shadow comparator.
      const uiResult = await scrapeInbox(ctx, {
        mode: req.body.mode,
        since: req.body.since,
        hostDisplayName: req.body.host_display_name,
      });
      messages = uiResult.messages;
      bookingsFound = uiResult.bookingsFound;
      errors.push(...uiResult.errors);
      const apiResult = await runApiReaderShadowCycle(ctx, env);
      apiDiag = apiResult;
    } else {
      // api mode — API cycle is sole emitter.
      const apiResult = await runApiReaderEmissionCycle(ctx, env);
      messages = apiResult.messages;
      bookingsFound = 0; // bookings extraction is a v1 follow-up
      apiDiag = apiResult.diag;
      if (apiResult.error) errors.push(apiResult.error);
      commitWatermarks = apiResult.commitWatermarks;
    }

    const batches = chunk(messages, MAX_BATCH_SIZE);
    // Always emit at least one batch so the callback handler sees has_more=false closure even
    // when there are zero messages (avoids callers inferring "sync never completed").
    const effective = batches.length > 0 ? batches : [[] as ScrapedMessage[]];

    const callbackErrors: string[] = [];
    for (let i = 0; i < effective.length; i++) {
      const isLast = i === effective.length - 1;
      const body = {
        action: 'sync_messages_batch' as const,
        host_id: env.HOST_ID,
        payload: {
          messages: effective[i],
          page: i + 1,
          has_more: !isLast,
        },
        timestamp: new Date().toISOString(), // for current staysync-app callback route skew check
      };
      try {
        const resCb = await postCallback({ env, body });
        if (!resCb.ok) {
          callbackErrors.push(`batch_${i + 1}_status_${resCb.status}`);
        }
      } catch (err) {
        callbackErrors.push(
          `batch_${i + 1}_error: ` + (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // api mode + all batches succeeded → commit watermark advances.
    // Per spec §4 step 6 (post-2xx ack only). Audit B2 unified finding.
    if (env.INBOX_READER_MODE === 'api' && callbackErrors.length === 0) {
      commitWatermarks();
    }

    const diag = (globalThis as unknown as { __lastInboxDiag?: unknown }).__lastInboxDiag;
    return res.status(200).json({
      messages_found: messages.length,
      bookings_found: bookingsFound,
      errors: [...errors, ...callbackErrors],
      diag,
      apiDiag,
    });
  };
}

/**
 * v0.3 helper — runs one API-reader cycle in shadow mode (no callback emission).
 * Returns the diagnostic for inclusion in the /sync response. The shadow
 * comparator gating the watermark advance is supplied here; UI batch handoff
 * is a future enhancement (v0.4 wiring) — for v0.3 the comparator returns an
 * empty intersection so watermarks don't advance from shadow alone, allowing
 * UI scraper progress to be the source of truth during observation.
 */
async function runApiReaderShadowCycle(
  ctx: Awaited<ReturnType<typeof getBrowserContext>>,
  env: MachineEnv,
): Promise<{ apiSkipReason?: string; messagesEmitted: number; perThread: number }> {
  if (!env.AIRBNB_API_USER_ID || !env.AIRBNB_API_GLOBAL_USER_ID) {
    // Configuration guard — should not reach here per env validation.
    return { apiSkipReason: 'missing_api_user_id', messagesEmitted: 0, perThread: 0 };
  }
  let page;
  try {
    page = ctx.pages()[0] ?? (await ctx.newPage());
  } catch {
    return { apiSkipReason: 'no_page_available', messagesEmitted: 0, perThread: 0 };
  }
  const spa = ensureSpaListenerOnPage(page);
  const watermarkStore = new WatermarkStore(env.WATERMARKS_PATH);

  // Default shadow comparator: no UI batch known to this thin sidecar surface.
  // Returns empty advance + diagnostic so v0.3 captures observation traffic
  // without advancing watermarks. v0.4 wiring will integrate UI batch handoff.
  const outcome = await runApiReaderCycle(page, {
    mode: 'shadow',
    hostNumericId: env.AIRBNB_API_USER_ID,
    globalUserId: env.AIRBNB_API_GLOBAL_USER_ID,
    apiKey: env.AIRBNB_API_KEY,
    inboxHashFallback: env.AIRBNB_API_INBOX_HASH,
    threadHashFallback: env.AIRBNB_API_THREAD_HASH,
    watermarkStore,
    spa,
    shadowCompare: async ({ cycleId, apiMessages }) => ({
      advance: {},
      diagnostic: {
        cycleId,
        uiBatchTimedOut: true,
        uiToApiIdMatches: 0,
        uiToApiIdMismatches: 0,
        onlyInUi: [],
        onlyInApi: apiMessages.map(m => m.airbnb_message_id),
      },
    }),
  });

  return {
    apiSkipReason: outcome.apiSkipReason,
    messagesEmitted: outcome.totalApiMessagesEmitted,
    perThread: outcome.perThread.length,
  };
}

/**
 * Sanitize a CycleOutcome for inclusion in the /sync response. Strips message
 * content (Codex v0.3 audit M3 — prevents diagnostic PII leak). Keeps shape
 * info, counts, hashes, IDs, timestamps, and skip-reasons.
 */
function sanitizeApiDiag(outcome: unknown): unknown {
  if (!outcome || typeof outcome !== 'object') return outcome;
  const o = outcome as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'apiMessages') {
      // Replace with count-only summary.
      sanitized[k] = Array.isArray(v) ? { _count: v.length } : v;
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

/**
 * v0.3 helper — runs one API-reader cycle in `api` mode. Returns messages to
 * emit + a `commitWatermarks` callable. Caller MUST invoke commitWatermarks()
 * only after the callback returns 2xx for ALL batches (spec §4 step 6 +
 * Codex/Sonnet/Gemini v0.3 audit B2 unified finding).
 */
async function runApiReaderEmissionCycle(
  ctx: Awaited<ReturnType<typeof getBrowserContext>>,
  env: MachineEnv,
): Promise<{
  messages: ScrapedMessage[];
  diag: unknown;
  error: string | null;
  commitWatermarks: () => void;
}> {
  const noop = () => undefined;
  if (!env.AIRBNB_API_USER_ID || !env.AIRBNB_API_GLOBAL_USER_ID) {
    return { messages: [], diag: null, error: 'missing_api_user_id', commitWatermarks: noop };
  }
  let page;
  try {
    page = ctx.pages()[0] ?? (await ctx.newPage());
  } catch (err) {
    return {
      messages: [],
      diag: null,
      error: 'no_page_available: ' + (err instanceof Error ? err.message : String(err)),
      commitWatermarks: noop,
    };
  }
  // Page-level listener is a redundant belt-and-suspenders alongside the
  // context-level install in browser.ts (which is the primary attachment).
  const spa = ensureSpaListenerOnPage(page);
  const watermarkStore = new WatermarkStore(env.WATERMARKS_PATH);
  const outcome = await runApiReaderCycle(page, {
    mode: 'api',
    hostNumericId: env.AIRBNB_API_USER_ID,
    globalUserId: env.AIRBNB_API_GLOBAL_USER_ID,
    apiKey: env.AIRBNB_API_KEY,
    inboxHashFallback: env.AIRBNB_API_INBOX_HASH,
    threadHashFallback: env.AIRBNB_API_THREAD_HASH,
    watermarkStore,
    spa,
  });

  if (!outcome.ok) {
    return {
      messages: [],
      diag: sanitizeApiDiag(outcome),
      error: outcome.apiSkipReason ?? outcome.inboxFailureReason ?? 'unknown',
      commitWatermarks: noop,
    };
  }
  // Defer watermark persistence to caller (post-callback ack).
  const advances = outcome.watermarkAdvancesApplied;
  const commitWatermarks = (): void => {
    if (Object.keys(advances).length === 0) return;
    try {
      const prev = watermarkStore.load();
      const merged = watermarkStore.merge(prev, advances);
      watermarkStore.save(merged);
    } catch {
      // Persistence failure is non-fatal; cold-start handling kicks in next cycle.
    }
  };
  return {
    messages: outcome.apiMessages,
    diag: sanitizeApiDiag(outcome),
    error: null,
    commitWatermarks,
  };
}
