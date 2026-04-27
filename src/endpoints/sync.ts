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
      // on the shared page. UI remains sole callback emitter; API output is
      // compared against UI inline (v0.4 prerequisite — real shadow gate)
      // and surfaced in apiDiag for the 3-day promotion gate.
      const uiResult = await scrapeInbox(ctx, {
        mode: req.body.mode,
        since: req.body.since,
        hostDisplayName: req.body.host_display_name,
      });
      messages = uiResult.messages;
      bookingsFound = uiResult.bookingsFound;
      errors.push(...uiResult.errors);
      const apiResult = await runApiReaderShadowCycle(ctx, env, uiResult.messages);
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
 * Compute shadow-mode comparison between UI batch and API batch.
 *
 * Per spec §4 step 6 + §9 invariant 9: equivalence gate uses subset
 * (UI ⊆ API) and zero `onlyInUi` events; `onlyInApi` is tolerated because
 * UI's DOM virtualizes (~15-20 visible rows per thread) while the API
 * returns up to 50 per page per thread.
 *
 * Returns:
 *   - advance: per-thread max createdAtMs of the intersection (UI ∩ API).
 *     Watermark advances only over messages BOTH sides confirmed.
 *   - diagnostic: counts + onlyInUi[]/onlyInApi[] message IDs (NOT bodies).
 */
/**
 * Canonical message ID form emitted by the API reader: `airbnb-${numericMsgId}`
 * (decoded from base64 `Message:<numericId>` Relay node-ID per spec §1 DoD).
 *
 * The UI scraper emits the same form when DOM `data-item-id` is present, but
 * has a fallback path (`stableMessageId`) that emits a 32-char hex content
 * hash for rows without `data-item-id`. Those non-canonical UI IDs are NEVER
 * comparable to API output and must be excluded from the equivalence gate.
 *
 * Codex v0.4-prereq audit Blocker: without this discriminator, every UI
 * fallback row becomes a phantom `onlyInUi` mismatch and blocks promotion
 * indefinitely.
 */
const CANONICAL_MESSAGE_ID = /^airbnb-\d{6,}$/;

/**
 * Note on the v0.4-vs-spec deviation: spec §4 step 6 describes an
 * `awaitUiBatchForCycle(cycleId, timeoutMs=10000)` queue model. v0.4 wires the
 * UI batch as a synchronous parameter (sequential UI → API in /sync), so a
 * timeout is structurally impossible at this layer. The queue model belongs to
 * v0.5+; until then, no `uiBatchTimedOut` field is emitted to avoid confusing
 * downstream operator tooling (Sonnet v0.4 audit P1 noted hardcoded `false`
 * misleads consumers).
 */
export function computeShadowComparison(
  uiMessages: ScrapedMessage[],
  apiMessages: ScrapedMessage[],
  cycleId: string,
): {
  advance: Record<string, number>;
  diagnostic: {
    cycleId: string;
    uiCanonicalCount: number;
    uiNonCanonicalCount: number;
    apiCanonicalCount: number;
    uiToApiIdMatches: number;
    uiToApiIdMismatches: number;
    onlyInUi: string[];
    onlyInApi: string[];
  };
} {
  // Build canonical sets only — non-canonical UI IDs are tracked via count
  // but excluded from the equivalence gate.
  const uiCanonical = new Map<string, ScrapedMessage>();
  let uiNonCanonical = 0;
  for (const m of uiMessages) {
    if (CANONICAL_MESSAGE_ID.test(m.airbnb_message_id)) {
      uiCanonical.set(m.airbnb_message_id, m);
    } else {
      uiNonCanonical += 1;
    }
  }
  const apiCanonical = new Map<string, ScrapedMessage>();
  for (const m of apiMessages) {
    if (CANONICAL_MESSAGE_ID.test(m.airbnb_message_id)) {
      apiCanonical.set(m.airbnb_message_id, m);
    }
  }

  const onlyInUi: string[] = [];
  const onlyInApi: string[] = [];
  for (const id of uiCanonical.keys()) if (!apiCanonical.has(id)) onlyInUi.push(id);
  for (const id of apiCanonical.keys()) if (!uiCanonical.has(id)) onlyInApi.push(id);

  // Watermark advance: per-thread max createdAtMs across the INTERSECTION only
  // (Sonnet R2 vacuous-match defense — empty intersection → no advance even if
  // subset trivially holds because UI batch was empty).
  const advance: Record<string, number> = {};
  for (const [id, apiMsg] of apiCanonical.entries()) {
    if (!uiCanonical.has(id)) continue;
    const t = Date.parse(apiMsg.timestamp);
    if (!Number.isFinite(t)) continue;
    const cur = advance[apiMsg.conversation_airbnb_id];
    if (typeof cur !== 'number' || t > cur) {
      advance[apiMsg.conversation_airbnb_id] = t;
    }
  }

  return {
    advance,
    diagnostic: {
      cycleId,
      uiCanonicalCount: uiCanonical.size,
      uiNonCanonicalCount: uiNonCanonical,
      apiCanonicalCount: apiCanonical.size,
      uiToApiIdMatches: uiCanonical.size - onlyInUi.length,
      uiToApiIdMismatches: onlyInUi.length, // onlyInUi == promotion-blocking mismatches
      onlyInUi,
      onlyInApi,
    },
  };
}

/**
 * v0.4 helper — runs one API-reader cycle in shadow mode with a real
 * shadow comparator wired to the UI scraper's batch from the same /sync
 * invocation. Per spec §4 step 6: subset (UI ⊆ API) check + intersection-only
 * watermark advance.
 *
 * UI batch is captured BEFORE this is invoked (see /sync handler shadow
 * branch); the comparator runs synchronously inside runApiReaderCycle's
 * post-cycle phase via the shadowCompare callback.
 */
async function runApiReaderShadowCycle(
  ctx: Awaited<ReturnType<typeof getBrowserContext>>,
  env: MachineEnv,
  uiMessages: ScrapedMessage[],
): Promise<{
  apiSkipReason?: string;
  messagesEmitted: number;
  perThread: number;
  shadow?: {
    cycleId: string;
    uiBatchSize: number;
    uiToApiIdMatches: number;
    uiToApiIdMismatches: number;
    onlyInUi: string[];
    onlyInApi: string[];
    intersectionWatermarkAdvances: number;
  };
}> {
  if (!env.AIRBNB_API_USER_ID || !env.AIRBNB_API_GLOBAL_USER_ID) {
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

  const outcome = await runApiReaderCycle(page, {
    mode: 'shadow',
    hostNumericId: env.AIRBNB_API_USER_ID,
    globalUserId: env.AIRBNB_API_GLOBAL_USER_ID,
    apiKey: env.AIRBNB_API_KEY,
    inboxHashFallback: env.AIRBNB_API_INBOX_HASH,
    threadHashFallback: env.AIRBNB_API_THREAD_HASH,
    watermarkStore,
    spa,
    shadowCompare: async ({ cycleId, apiMessages }) => {
      const { advance, diagnostic } = computeShadowComparison(uiMessages, apiMessages, cycleId);
      return { advance, diagnostic };
    },
  });

  const intersectionAdvances = Object.keys(outcome.watermarkAdvancesApplied).length;

  return {
    apiSkipReason: outcome.apiSkipReason,
    messagesEmitted: outcome.totalApiMessagesEmitted,
    perThread: outcome.perThread.length,
    shadow: outcome.shadow
      ? {
          cycleId: outcome.shadow.cycleId,
          uiBatchSize: uiMessages.length,
          uiToApiIdMatches: outcome.shadow.uiToApiIdMatches,
          uiToApiIdMismatches: outcome.shadow.uiToApiIdMismatches,
          // Trim ID lists to first 20 to keep response sizes bounded.
          onlyInUi: outcome.shadow.onlyInUi.slice(0, 20),
          onlyInApi: outcome.shadow.onlyInApi.slice(0, 20),
          intersectionWatermarkAdvances: intersectionAdvances,
        }
      : undefined,
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
