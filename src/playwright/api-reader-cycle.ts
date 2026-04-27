/**
 * API-reader cycle orchestrator.
 *
 * Wraps `listInboxViaApi` + per-thread `readThreadViaApi` calls into one cycle
 * that respects:
 *   - INBOX_READER_MODE (ui/shadow/api)
 *   - authEpoch.ready gate (skip if not ready) + start-vs-end epoch consistency
 *   - SPA observation gate (skip if no inbox/thread hash + clientVersion seen)
 *   - per-thread sequential fetch with 500–1500ms randomized jitter
 *   - watermark advancement per spec §4 step 6 (mode-aware)
 *
 * v0.3 ships the OPS for shadow + api modes. The shadow comparator
 * (awaitUiBatchForCycle) is wired through an opt-in callback so the existing
 * UI scraper can hand its batch to this orchestrator without coupling.
 */

import type { Page } from 'playwright';
import { currentAuthEpoch, isAuthEpochReady } from './auth-epoch';
import {
  type InboxFailureReason,
  type InboxReaderMode,
  type ScrapedMessage,
  type ThreadDiagnostics,
  listInboxViaApi,
  readThreadViaApi,
} from './api-reader';
import type { SpaListener } from './spa-listener';
import type { WatermarkStore, WatermarkMap } from './watermark-store';

export interface CycleOptions {
  mode: InboxReaderMode;
  hostNumericId: string;
  globalUserId: string;
  apiKey: string;
  /** Env-pinned fallback if listener has no inbox hash yet. */
  inboxHashFallback: string;
  /** Env-pinned fallback if listener has no thread hash yet. */
  threadHashFallback: string;
  /** Env-pinned fallback if listener has no client version yet. */
  clientVersionFallback?: string;
  numRequestedThreads?: number;
  numRequestedMessages?: number;
  maxCursorWalksPerThread?: number;
  /** Inter-thread jitter range in ms; spec §4 says 500–1500. */
  interThreadJitterMs?: { minMs: number; maxMs: number };
  watermarkStore: WatermarkStore;
  spa: SpaListener;
  /**
   * Shadow comparator. Called per cycle with the API messages we'd emit.
   * Implementation provides the synchronous awaitUiBatchForCycle semantics
   * per spec §4 step 6 + §9 invariant: subset (UI ⊆ API) + zero onlyInUi
   * + intersection-only watermark advance. Return value is the per-thread
   * watermark advancement (numeric max createdAtMs of the intersection).
   */
  shadowCompare?: (input: {
    cycleId: string;
    apiMessages: ScrapedMessage[];
  }) => Promise<{
    advance: WatermarkMap;
    diagnostic: ShadowDiagnostic;
  }>;
}

export interface ShadowDiagnostic {
  cycleId: string;
  /** Canonical UI message ID count (form: `airbnb-${numericId}`). */
  uiCanonicalCount: number;
  /** UI rows whose ID didn't match the canonical form (e.g. content-hash fallback
   *  from scrape-inbox.ts when DOM data-item-id was absent). Excluded from the
   *  equivalence gate per audit. */
  uiNonCanonicalCount: number;
  apiCanonicalCount: number;
  uiToApiIdMatches: number;
  uiToApiIdMismatches: number;
  onlyInUi: string[];
  onlyInApi: string[];
}

export interface CycleOutcome {
  cycleId: string;
  cycleStartAuthEpoch: number;
  cycleEndAuthEpoch: number;
  authEpochAborted: boolean;
  mode: InboxReaderMode;
  ok: boolean;
  apiSkipReason?:
    | 'auth_epoch_not_ready'
    | 'no_spa_observation'
    | 'inbox_failed'
    | 'auth_epoch_changed';
  inboxFailureReason?: InboxFailureReason;
  apiMessages: ScrapedMessage[];
  perThread: Array<ThreadDiagnostics>;
  totalApiMessagesEmitted: number;
  watermarkAdvancesApplied: WatermarkMap;
  shadow?: ShadowDiagnostic;
  inboxHashUsed: string;
  threadHashUsed: string;
  clientVersionUsed: string | null;
  elapsedMs: number;
}

function genCycleId(): string {
  return `cycle-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function pickJitterMs(range: { minMs: number; maxMs: number }, rng: () => number): number {
  const span = Math.max(0, range.maxMs - range.minMs);
  return range.minMs + Math.floor(rng() * (span + 1));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run one inbox-read cycle. Throws on programmer error; returns CycleOutcome
 * for all spec-defined failure paths so the caller can surface diagnostics.
 *
 * UI mode: returns immediately with apiMessages=[] and apiSkipReason='ui_mode'
 * is NOT used — the orchestrator is simply not invoked in ui mode. Callers
 * gate at the dispatch level.
 */
export async function runApiReaderCycle(
  page: Page,
  opts: CycleOptions,
): Promise<CycleOutcome> {
  const startedAt = Date.now();
  const cycleId = genCycleId();
  const mode = opts.mode;
  const cycleStartAuthEpoch = currentAuthEpoch();
  const numRequestedThreads = opts.numRequestedThreads ?? 15;
  const numRequestedMessages = opts.numRequestedMessages ?? 50;
  const maxCursorWalks = opts.maxCursorWalksPerThread ?? 5;
  const jitter = opts.interThreadJitterMs ?? { minMs: 500, maxMs: 1500 };
  const obs = opts.spa.observation();
  const inboxHash = obs.inboxHash ?? opts.inboxHashFallback;
  const threadHash = obs.threadHash ?? opts.threadHashFallback;
  const clientVersion = obs.clientVersion ?? opts.clientVersionFallback ?? null;

  const baseOutcome: CycleOutcome = {
    cycleId,
    cycleStartAuthEpoch,
    cycleEndAuthEpoch: cycleStartAuthEpoch,
    authEpochAborted: false,
    mode,
    ok: false,
    apiMessages: [],
    perThread: [],
    totalApiMessagesEmitted: 0,
    watermarkAdvancesApplied: {},
    inboxHashUsed: inboxHash,
    threadHashUsed: threadHash,
    clientVersionUsed: clientVersion,
    elapsedMs: 0,
  };

  // 1. authEpoch.ready gate (spec §4 step 1).
  if (!isAuthEpochReady()) {
    return finalize({ ...baseOutcome, apiSkipReason: 'auth_epoch_not_ready' }, startedAt);
  }

  // 2. SPA observation gate (spec §4 step 2). In ui/shadow modes, skip cycle if
  //    listener hasn't captured a clientVersion yet — DO NOT force reload.
  //    In api mode, the caller MAY trigger a reload before retrying; this
  //    function does not force one.
  if (clientVersion === null) {
    return finalize({ ...baseOutcome, apiSkipReason: 'no_spa_observation' }, startedAt);
  }

  // 3. Inbox listing.
  const inboxResult = await listInboxViaApi(page, {
    mode,
    hostNumericId: opts.hostNumericId,
    globalUserId: opts.globalUserId,
    inboxHash,
    threadHash,
    apiKey: opts.apiKey,
    clientVersion,
    numRequestedThreads,
  });
  if (!inboxResult.ok) {
    return finalize(
      { ...baseOutcome, apiSkipReason: 'inbox_failed', inboxFailureReason: inboxResult.reason },
      startedAt,
    );
  }

  // 4. Per-thread sequential fetch + watermark gating.
  const watermarks = opts.watermarkStore.load();
  const apiMessagesAccum: ScrapedMessage[] = [];
  const perThread: ThreadDiagnostics[] = [];
  let firstThread = true;
  for (const t of inboxResult.threads) {
    // Inter-thread jitter (skip before the first thread).
    if (!firstThread) {
      await delay(pickJitterMs(jitter, Math.random));
    }
    firstThread = false;

    // Mid-cycle authEpoch check.
    if (currentAuthEpoch() !== cycleStartAuthEpoch) {
      return finalize(
        {
          ...baseOutcome,
          authEpochAborted: true,
          apiSkipReason: 'auth_epoch_changed',
          perThread,
        },
        startedAt,
      );
    }

    const watermarkMs = watermarks[t.rawId];
    const threadResult = await readThreadViaApi(page, {
      rawThreadId: t.rawId,
      globalThreadId: t.globalThreadId,
      hostNumericId: opts.hostNumericId,
      threadHash,
      apiKey: opts.apiKey,
      clientVersion,
      numRequestedMessages,
      watermarkMs,
      maxCursorWalks,
    });
    if (!threadResult.ok) {
      // Per-thread failures (thread_host_mismatch, identity_mismatch,
      // schema_mismatch, http_error) are recoverable: drop thread, continue.
      // cookie_invalid and persisted_query_not_found are NOT recoverable here —
      // surface them by short-circuiting the cycle so the dispatcher can react.
      if (
        threadResult.reason === 'cookie_invalid' ||
        threadResult.reason === 'persisted_query_not_found' ||
        threadResult.reason === 'wrong_host'
      ) {
        return finalize(
          {
            ...baseOutcome,
            inboxFailureReason: threadResult.reason,
            apiSkipReason: 'inbox_failed',
            perThread,
          },
          startedAt,
        );
      }
      perThread.push(threadResult.diagnostics);
      continue;
    }
    apiMessagesAccum.push(...threadResult.messages);
    perThread.push(threadResult.diagnostics);
  }

  // 5. Final authEpoch check before emit (spec §2 invariant 7).
  const cycleEndAuthEpoch = currentAuthEpoch();
  if (cycleEndAuthEpoch !== cycleStartAuthEpoch) {
    return finalize(
      {
        ...baseOutcome,
        authEpochAborted: true,
        apiSkipReason: 'auth_epoch_changed',
        cycleEndAuthEpoch,
        perThread,
      },
      startedAt,
    );
  }

  // 6. Mode-specific watermark + emission.
  let shadow: ShadowDiagnostic | undefined;
  let watermarkAdvancesApplied: WatermarkMap = {};

  if (mode === 'api') {
    // Caller will hand apiMessagesAccum to the StaySync callback. We optimistically
    // advance watermarks based on emitted-per-thread max; the caller is responsible
    // for ONLY advancing AFTER callback returns 2xx (per spec §4 step 6).
    // For v0.3 we expose the proposed advances in the outcome; persistence happens
    // in the dispatcher after callback ack.
    const proposed: WatermarkMap = {};
    for (const m of apiMessagesAccum) {
      const cur = proposed[m.conversation_airbnb_id] ?? 0;
      const t = Date.parse(m.timestamp);
      if (Number.isFinite(t) && t > cur) proposed[m.conversation_airbnb_id] = t;
    }
    watermarkAdvancesApplied = proposed;
  } else if (mode === 'shadow') {
    if (!opts.shadowCompare) {
      // Shadow mode without a comparator is a misconfiguration; surface but don't
      // advance the watermark.
      shadow = {
        cycleId,
        uiCanonicalCount: 0,
        uiNonCanonicalCount: 0,
        apiCanonicalCount: apiMessagesAccum.length,
        uiToApiIdMatches: 0,
        uiToApiIdMismatches: 0,
        onlyInUi: [],
        onlyInApi: apiMessagesAccum.map(m => m.airbnb_message_id),
      };
    } else {
      const cmp = await opts.shadowCompare({ cycleId, apiMessages: apiMessagesAccum });
      shadow = cmp.diagnostic;
      watermarkAdvancesApplied = cmp.advance;
    }
    // In shadow mode, persist advances NOW — emission is via UI scraper, so
    // there's no callback ack to gate on; the comparator already gated on
    // intersection.
    if (Object.keys(watermarkAdvancesApplied).length > 0) {
      const merged = opts.watermarkStore.merge(watermarks, watermarkAdvancesApplied);
      try {
        opts.watermarkStore.save(merged);
      } catch {
        // Persistence failure is non-fatal — next cycle treats as cold start.
      }
    }
  }

  return finalize(
    {
      ...baseOutcome,
      ok: true,
      cycleEndAuthEpoch,
      apiMessages: apiMessagesAccum,
      perThread,
      totalApiMessagesEmitted: apiMessagesAccum.length,
      watermarkAdvancesApplied,
      shadow,
    },
    startedAt,
  );
}

function finalize(out: CycleOutcome, startedAt: number): CycleOutcome {
  return { ...out, elapsedMs: Date.now() - startedAt };
}
