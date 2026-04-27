/**
 * Airbnb persisted-GraphQL inbox reader (v0.2).
 *
 * Replaces UI-parser thread navigation in scrape-inbox.ts with direct calls to
 * Airbnb's `ViaductInboxData` (v0.1) and `ViaductGetThreadAndDataQuery` (v0.2)
 * persisted-query endpoints. v0.2 ships:
 *   - thread-read with identity gates
 *   - hydratedContent extractors for TEXT / MEDIA / VIEWER_BASED / TEMPLATE / STATIC_BULLETIN
 *   - per-thread cursor walk (cap 5 / cycle, gated on watermark gap)
 *   - per-thread `createdAtMs ASC` sort
 *   - soft-delete drop, reaction-without-parent drop
 *
 * Shadow comparator + INBOX_READER_MODE wiring land in v0.3; cutover in v0.4.
 *
 * See specs/SPEC-airbnb-api-reader-v2.md for the full contract.
 *
 * Modes (env: INBOX_READER_MODE):
 *   - ui (default)     — UI scraper is sole emitter; api-reader is dead code.
 *   - shadow           — api-reader runs in parallel; emissions go to side channel only.
 *   - api              — api-reader is sole emitter; UI scraper disabled.
 *
 * Spec hard-rules carried in:
 *   - Never log cookies, headers (raw values), bodies, or message text.
 *   - Fail closed on weak thread identity / weak host membership / weak cookie validity.
 *   - GlobalThreadId is ALWAYS extracted from response, never constructed.
 *   - Decoded-numeric equivalence (decode → strip "Message:" prefix) is the dedup key
 *     when comparing API ids vs UI's data-item-id.
 */

import { randomBytes } from 'crypto';
import type { Page } from 'playwright';

export type InboxReaderMode = 'ui' | 'shadow' | 'api';

export interface ApiReaderOptions {
  mode: InboxReaderMode;
  /** Numeric host accountId (e.g. "50758264"). Used for host-membership invariant. */
  hostNumericId: string;
  /** base64('Viewer:<numericId>') — pinned. */
  globalUserId: string;
  /** Persisted-query hash for ViaductInboxData. */
  inboxHash: string;
  /** Persisted-query hash for ViaductGetThreadAndDataQuery (unused in v0.1). */
  threadHash: string;
  /** x-airbnb-api-key (web client key). */
  apiKey: string;
  /** SPA build hash for x-client-version. Captured by session listener. */
  clientVersion: string;
  numRequestedThreads?: number;
  /** Random-source override for tests; defaults to Node's crypto.randomBytes. */
  randomBytes?: (size: number) => Buffer;
}

export interface InboxThreadRef {
  rawId: string;
  globalThreadId: string;
  participantAccountIds: string[];
}

export type InboxValidationOutcome =
  | {
      ok: true;
      threads: InboxThreadRef[];
      diagnostics: InboxDiagnostics;
    }
  | {
      ok: false;
      reason: InboxFailureReason;
      diagnostics: InboxDiagnostics;
    };

/**
 * Discriminator for failed inbox + thread reads. Each reason maps to a distinct
 * caller action per spec §4 failure-modes table:
 *   - cookie_invalid             → set `cookie_valid=false`, abort cycle, surface alert.
 *   - persisted_query_not_found  → trigger hash auto-recovery (mode-gated reload).
 *   - wrong_host                 → ACCOUNT-LEVEL: set `cookie_valid=false`, abort cycle.
 *                                  Use only when the entire inbox lacks the host's accountId
 *                                  on every thread.
 *   - thread_host_mismatch       → THREAD-LEVEL: drop this single thread, continue cycle.
 *                                  Use when one thread's participants don't include the host
 *                                  but other threads in the cycle do (re-assigned, demoted).
 *   - identity_mismatch          → THREAD-LEVEL: response.threadData.id decodes to a
 *                                  different rawId than the one requested. Drop thread.
 *   - schema_mismatch            → log diagnostic, abort cycle, alert (Airbnb shipped a
 *                                  GraphQL schema change we don't recognize).
 *   - http_error                 → transport/network failure (timeout, DNS, TLS,
 *                                  execution-context-destroyed). Retry next cycle.
 */
export type InboxFailureReason =
  | 'cookie_invalid'
  | 'persisted_query_not_found'
  | 'wrong_host'
  | 'thread_host_mismatch'
  | 'identity_mismatch'
  | 'schema_mismatch'
  | 'http_error';

export interface InboxDiagnostics {
  threadsRequested: number;
  threadsReturned: number;
  threadsDroppedUnknownPrefix: number;
  threadsDroppedIdentityMismatch: number;
  threadsDroppedHostMembership: number;
  inboxHashUsed: string;
  schemaFingerprintOk: boolean;
}

/**
 * Whitelist of Relay node-type prefixes accepted as inbox threads.
 * Probe 2026-04-26 confirmed all 15 host inbox threads use `MessageThread:`.
 * Any other prefix → drop + alert (per §2 invariant + §5).
 */
export const ALLOWED_THREAD_PREFIXES = ['MessageThread'] as const;

/**
 * Whitelist of Relay node-type prefixes accepted as messages.
 * Used in v0.2 thread-read path; included here for completeness.
 */
export const ALLOWED_MESSAGE_PREFIXES = ['Message'] as const;

const TRACE_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TRACE_REJECT_THRESHOLD = 252; // floor(256 / 36) * 36

/**
 * Generate a 28-char base36 trace ID matching the format observed in SPA traffic.
 * Uses rejection sampling to eliminate the +12.5% relative bias that naive `b % 36`
 * produces (256 mod 36 = 4 over-represented chars). See spec §3.
 *
 * Accepts an optional random-source override for deterministic tests.
 */
export function generateTraceId(
  rng: (size: number) => Buffer = randomBytes,
): string {
  const out = new Array<string>(28);
  let i = 0;
  while (i < 28) {
    const buf = rng(28 - i + 8);
    for (const b of buf) {
      if (b >= TRACE_REJECT_THRESHOLD) continue;
      out[i++] = TRACE_ID_CHARS[b % 36];
      if (i === 28) break;
    }
  }
  return out.join('');
}

/**
 * Decode a Relay node-id (base64 of `<TypeName>:<id>`) into its parts.
 * Throws on missing `:` separator. (Note: Buffer.from(_, 'base64') in Node
 * silently skips invalid characters rather than throwing — Sonnet v0.1 audit
 * noted this; we rely on the colon-separator check for malformed input.)
 */
export function decodeRelayId(globalId: string): {
  prefix: string;
  raw: string;
} {
  const decoded = Buffer.from(globalId, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) {
    throw new Error('missing_typename_separator');
  }
  return { prefix: decoded.slice(0, colon), raw: decoded.slice(colon + 1) };
}

/** Numeric Relay ID pattern per spec §2 `RawThreadId`. */
const RAW_NUMERIC_ID = /^\d{6,}$/;

/**
 * Inspect a GraphQL `errors[]` envelope and classify into our reason union.
 * Per spec §4 failure modes, PERSISTED_QUERY_NOT_FOUND is its own failure
 * mode (hash rotation, not auth). Auth-related codes collapse to cookie_invalid.
 * Anything else also maps to cookie_invalid defensively.
 */
function classifyGraphqlErrors(errors: unknown[]): InboxFailureReason {
  for (const errUnknown of errors) {
    if (!errUnknown || typeof errUnknown !== 'object') continue;
    const err = errUnknown as Record<string, unknown>;
    const ext = err.extensions as Record<string, unknown> | undefined;
    const code = typeof ext?.code === 'string' ? ext.code : '';
    const msg = typeof err.message === 'string' ? err.message : '';
    if (
      code === 'PERSISTED_QUERY_NOT_FOUND' ||
      msg.includes('PersistedQueryNotFound') ||
      msg.includes('PERSISTED_QUERY_NOT_FOUND')
    ) {
      return 'persisted_query_not_found';
    }
  }
  return 'cookie_invalid';
}

/**
 * Pure validator for a `ViaductInboxData` response body. Used both at runtime
 * after `page.evaluate(fetch)` and in unit tests against committed fixtures.
 *
 * Implements per §2 invariants 1c (host-membership two-tier), 3 (schema
 * fingerprint), and §4 step 3 (allowlist-prefix decode). Never reads
 * `messages[]` content here — that's v0.2.
 */
export function validateInboxResponse(
  body: unknown,
  hostNumericId: string,
  inboxHashUsed: string,
  numRequestedThreads: number,
): InboxValidationOutcome {
  const diag: InboxDiagnostics = {
    threadsRequested: numRequestedThreads,
    threadsReturned: 0,
    threadsDroppedUnknownPrefix: 0,
    threadsDroppedIdentityMismatch: 0,
    threadsDroppedHostMembership: 0,
    inboxHashUsed,
    schemaFingerprintOk: false,
  };

  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'schema_mismatch', diagnostics: diag };
  }
  const root = body as Record<string, unknown>;

  // GraphQL errors[] envelope: PERSISTED_QUERY_NOT_FOUND vs auth vs other.
  // Spec §4 failure modes require the caller to distinguish PQNF (hash recovery)
  // from auth failures (cookie_valid=false).
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    return { ok: false, reason: classifyGraphqlErrors(root.errors), diagnostics: diag };
  }

  // Required-paths fingerprint: data.node.messagingInbox.inboxItems.{edges, pageInfo}
  const data = root.data as Record<string, unknown> | undefined;
  const node = data?.node as Record<string, unknown> | undefined;
  const messagingInbox = node?.messagingInbox as Record<string, unknown> | undefined;
  const inboxItems = messagingInbox?.inboxItems as Record<string, unknown> | undefined;
  const edgesUnknown = inboxItems?.edges;
  const pageInfo = inboxItems?.pageInfo;
  if (!Array.isArray(edgesUnknown) || pageInfo === undefined || pageInfo === null) {
    return { ok: false, reason: 'schema_mismatch', diagnostics: diag };
  }
  diag.schemaFingerprintOk = true;
  const edges = edgesUnknown as Array<unknown>;
  diag.threadsReturned = edges.length;

  const threads: InboxThreadRef[] = [];
  let hostFoundAnywhere = false;

  for (const edgeUnknown of edges) {
    const edge = edgeUnknown as Record<string, unknown> | null;
    const nodeRaw = edge?.node as Record<string, unknown> | undefined;
    if (!nodeRaw || typeof nodeRaw.id !== 'string') {
      diag.threadsDroppedIdentityMismatch += 1;
      continue;
    }
    let decoded: { prefix: string; raw: string };
    try {
      decoded = decodeRelayId(nodeRaw.id);
    } catch {
      diag.threadsDroppedUnknownPrefix += 1;
      continue;
    }
    if (!ALLOWED_THREAD_PREFIXES.includes(decoded.prefix as (typeof ALLOWED_THREAD_PREFIXES)[number])) {
      diag.threadsDroppedUnknownPrefix += 1;
      continue;
    }
    // Per spec §2 RawThreadId value object: numeric string, /^\d{6,}$/.
    if (!RAW_NUMERIC_ID.test(decoded.raw)) {
      diag.threadsDroppedIdentityMismatch += 1;
      continue;
    }

    // Extract participant accountIds for host-membership check.
    const participants = nodeRaw.participants as Record<string, unknown> | undefined;
    const partEdgesUnknown = participants?.edges;
    if (!Array.isArray(partEdgesUnknown)) {
      // Schema fingerprint requires participants.edges to exist on every thread.
      diag.threadsDroppedIdentityMismatch += 1;
      continue;
    }
    const accountIds: string[] = [];
    for (const peUnknown of partEdgesUnknown) {
      const pe = peUnknown as Record<string, unknown> | null;
      const peNode = pe?.node as Record<string, unknown> | undefined;
      const accountId = peNode?.accountId;
      if (typeof accountId === 'string') {
        accountIds.push(accountId);
      }
    }
    const hostInThread = accountIds.includes(hostNumericId);
    if (!hostInThread) {
      diag.threadsDroppedHostMembership += 1;
      continue;
    }
    hostFoundAnywhere = true;
    threads.push({
      rawId: decoded.raw,
      globalThreadId: nodeRaw.id,
      participantAccountIds: accountIds,
    });
  }

  // Two-tier host-membership rule (spec §2 invariant 1c) + Codex/Sonnet v0.1 audit
  // refinement: distinguish wrong_host from schema_mismatch when no thread is host's.
  //   - Brand-new host with empty inbox: PASS vacuously.
  //   - All threads dropped due to schema/identity issues (no valid edge structure):
  //     schema_mismatch — Airbnb returned a structurally weird response.
  //   - All threads dropped due to unknown Relay prefix: schema_mismatch — new
  //     thread node-types appeared we don't recognize.
  //   - All threads dropped due to host-membership only: wrong_host — cookies are
  //     for a different account.
  //   - At least one thread accepted: ok with per-thread drops counted in diagnostics.
  if (edges.length > 0 && !hostFoundAnywhere) {
    if (
      diag.threadsDroppedHostMembership === 0 &&
      (diag.threadsDroppedUnknownPrefix > 0 || diag.threadsDroppedIdentityMismatch > 0)
    ) {
      return { ok: false, reason: 'schema_mismatch', diagnostics: diag };
    }
    return { ok: false, reason: 'wrong_host', diagnostics: diag };
  }

  return { ok: true, threads, diagnostics: diag };
}

/**
 * Build the headers map for an Airbnb persisted-GraphQL request.
 * Twelve headers per spec §3 — eight static, three per-request randoms,
 * one session-pinned x-client-version.
 */
export function buildApolloHeaders(opts: {
  apiKey: string;
  clientVersion: string;
  rng?: (size: number) => Buffer;
}): Record<string, string> {
  const traceId = () => generateTraceId(opts.rng);
  return {
    'x-airbnb-api-key': opts.apiKey,
    'x-airbnb-graphql-platform': 'web',
    'x-airbnb-graphql-platform-client': 'minimalist-niobe',
    'x-airbnb-supports-airlock-v2': 'true',
    'x-niobe-short-circuited': 'true',
    'x-csrf-token': '',
    'x-csrf-without-token': '1',
    'content-type': 'application/json',
    'x-airbnb-client-trace-id': traceId(),
    'x-airbnb-network-log-link': traceId(),
    'x-client-request-id': traceId(),
    'x-client-version': opts.clientVersion,
  };
}

/**
 * Build the URL for a `ViaductInboxData` GET request.
 * Variables match the full set per spec §3 Operation A.
 */
export function buildInboxUrl(opts: {
  inboxHash: string;
  globalUserId: string;
  numRequestedThreads: number;
}): string {
  const variables = {
    userId: opts.globalUserId,
    numRequestedThreads: opts.numRequestedThreads,
    numPriorityThreads: 2,
    getPriorityInbox: true,
    useUserThreadTag: true,
    originType: 'USER_INBOX',
    threadVisibility: 'UNARCHIVED',
    threadTagFilters: null,
    query: null,
    getLastReads: false,
    getThreadState: true,
    getParticipants: true,
    getInboxFields: true,
    getMessageFields: true,
    getInboxOnlyFields: false,
    getThreadOnlyFields: false,
    skipOldMessagePreviewFields: false,
  };
  const extensions = {
    persistedQuery: { version: 1, sha256Hash: opts.inboxHash },
  };
  const params = new URLSearchParams({
    operationName: 'ViaductInboxData',
    locale: 'en',
    currency: 'USD',
    variables: JSON.stringify(variables),
    extensions: JSON.stringify(extensions),
  });
  return `https://www.airbnb.com/api/v3/ViaductInboxData/${opts.inboxHash}?${params.toString()}`;
}

/**
 * v0.1 entry point. Fetches the inbox via persisted-GraphQL, validates the
 * response, returns thread refs. Does NOT fetch threads or emit messages —
 * that arrives in v0.2. Caller is responsible for `authEpoch.ready` gating
 * and INBOX_READER_MODE branching; until v0.3 wires shadow mode, this function
 * is dead code in production.
 *
 * Returns thread refs ready for v0.2 cursor walks. Throws on any unexpected
 * page-context failure; caller catches + maps to `cookie_invalid`.
 */
export async function listInboxViaApi(
  page: Page,
  opts: ApiReaderOptions,
): Promise<InboxValidationOutcome> {
  const numRequestedThreads = opts.numRequestedThreads ?? 15;
  const url = buildInboxUrl({
    inboxHash: opts.inboxHash,
    globalUserId: opts.globalUserId,
    numRequestedThreads,
  });
  const headers = buildApolloHeaders({
    apiKey: opts.apiKey,
    clientVersion: opts.clientVersion,
    rng: opts.randomBytes,
  });

  const emptyDiag = (): InboxDiagnostics => ({
    threadsRequested: numRequestedThreads,
    threadsReturned: 0,
    threadsDroppedUnknownPrefix: 0,
    threadsDroppedIdentityMismatch: 0,
    threadsDroppedHostMembership: 0,
    inboxHashUsed: opts.inboxHash,
    schemaFingerprintOk: false,
  });

  type FetchOutcome =
    | { kind: 'json'; body: unknown }
    | { kind: 'auth_http'; status: number } // 401, 403
    | { kind: 'http_error'; status: number; bodyText?: string } // other non-2xx
    | { kind: 'non_json'; status: number }; // 2xx with HTML/text body (e.g. challenge)

  let outcome: FetchOutcome;
  try {
    outcome = (await page.evaluate(
      async ({ url, headers }) => {
        const res = await fetch(url, { headers, credentials: 'include' });
        const status = res.status;
        if (status === 401 || status === 403) {
          return { kind: 'auth_http', status };
        }
        if (status < 200 || status >= 300) {
          // Capture response body for 404 PQNF detection (mirrors readThreadViaApi).
          // Cap at 1024 chars per hard rule (no full body logging).
          const text = await res.text().catch(() => '');
          return { kind: 'http_error', status, bodyText: text.slice(0, 1024) };
        }
        const text = await res.text();
        try {
          return { kind: 'json', body: JSON.parse(text) };
        } catch {
          return { kind: 'non_json', status };
        }
      },
      { url, headers },
    )) as FetchOutcome;
  } catch {
    return { ok: false, reason: 'http_error', diagnostics: emptyDiag() };
  }

  switch (outcome.kind) {
    case 'auth_http':
      return { ok: false, reason: 'cookie_invalid', diagnostics: emptyDiag() };
    case 'http_error': {
      // Spec §4 + Codex v0.3 audit: HTTP 404 may carry a PQNF errors envelope.
      // Detect and surface as persisted_query_not_found so the cycle scheduler
      // can trigger hash auto-recovery instead of treating it as transient.
      if (outcome.status === 404 && outcome.bodyText) {
        try {
          const parsed = JSON.parse(outcome.bodyText) as Record<string, unknown>;
          const errs = parsed.errors;
          if (Array.isArray(errs) && classifyGraphqlErrors(errs) === 'persisted_query_not_found') {
            return { ok: false, reason: 'persisted_query_not_found', diagnostics: emptyDiag() };
          }
        } catch {
          // Not JSON; fall through to text scan below.
        }
        if (
          outcome.bodyText.includes('PersistedQueryNotFound') ||
          outcome.bodyText.includes('PERSISTED_QUERY_NOT_FOUND')
        ) {
          return { ok: false, reason: 'persisted_query_not_found', diagnostics: emptyDiag() };
        }
      }
      return { ok: false, reason: 'http_error', diagnostics: emptyDiag() };
    }
    case 'non_json':
      // 2xx with HTML body almost always means a PerimeterX/Datadome interstitial
      // or login redirect — treat as cookie failure per spec §4 failure modes.
      return { ok: false, reason: 'cookie_invalid', diagnostics: emptyDiag() };
    case 'json':
      return validateInboxResponse(
        outcome.body,
        opts.hostNumericId,
        opts.inboxHash,
        numRequestedThreads,
      );
  }
}

// ============================================================================
// v0.2: thread-read + extractors + cursor walk
// ============================================================================

/**
 * Output shape sent to the StaySync callback. Same field names as the UI scraper
 * emits (see scrape-inbox.ts) so the callback's dedup contract is unchanged.
 */
export interface ScrapedMessage {
  airbnb_message_id: string;
  content: string;
  sender: 'guest' | 'host';
  /** ISO8601 — derived from `createdAtMs`. */
  timestamp: string;
  conversation_airbnb_id: string;
}

export interface ThreadDiagnostics {
  rawId: string;
  globalThreadId: string;
  threadHashUsed: string;
  schemaFingerprintOk: boolean;
  identityCheck: 'ok' | 'mismatch' | 'skip';
  hostMembership: 'ok' | 'missing';
  messagesReturned: number;
  messagesEmitted: number;
  droppedSoftDelete: number;
  droppedOrphanReaction: number;
  droppedSystem: number;
  droppedSchema: number;
  droppedOriginInvariant: number;
  droppedUnknownPrefix: number;
  droppedNonNumericId: number;
  contentTypeCounts: Record<string, number>;
  hasOlder: boolean;
  hasNewer: boolean;
  earliestCursor: string | null;
  latestCursor: string | null;
}

export type ThreadValidationOutcome =
  | {
      ok: true;
      messages: ScrapedMessage[];
      diagnostics: ThreadDiagnostics;
      /** Raw createdAtMs of every message returned by the API (pre-filter). Used by
       *  cursor-walk gating to compute oldest correctly even when the entire page
       *  is system/dropped. */
      rawCreatedAtMs: number[];
    }
  | {
      ok: false;
      reason: InboxFailureReason;
      diagnostics: ThreadDiagnostics;
      rawCreatedAtMs?: number[];
    };

/**
 * Result of `extractText` — disposes a message into routable output.
 * `kind: 'system'` and `kind: 'placeholder'` are NEVER emitted to the callback
 * in v0 (parity with UI scraper which skips senderType==='system'); they are
 * surfaced in diagnostics only.
 */
export type MessageExtract =
  | { kind: 'user'; text: string; mediaUris?: string[] }
  | { kind: 'system'; text: string }
  | { kind: 'placeholder'; text: string };

const KNOWN_CONTENT_TYPES = [
  'TEXT_CONTENT',
  'MEDIA_CONTENT',
  'VIEWER_BASED_CONTENT',
  'TEMPLATE_CONTENT',
  'STATIC_BULLETIN_CONTENT',
] as const;

/**
 * Extract routable text from a probe-confirmed `hydratedContent` shape.
 * Per spec §3 extractor table. Unknown contentTypes → placeholder.
 *
 * Caller MUST inspect the returned `kind`; only `'user'` is callback-eligible.
 */
export function extractText(message: unknown): MessageExtract {
  if (!message || typeof message !== 'object') {
    return { kind: 'placeholder', text: '[unsupported:contentType:non_object]' };
  }
  const m = message as Record<string, unknown>;
  const contentType = typeof m.contentType === 'string' ? m.contentType : '';
  const contentSubType = typeof m.contentSubType === 'string' ? m.contentSubType : '';
  const account = (m.account as Record<string, unknown> | undefined) ?? {};
  const accountType = typeof account.accountType === 'string' ? account.accountType : '';
  const hydrated = m.hydratedContent as Record<string, unknown> | undefined;
  const content = hydrated?.content as Record<string, unknown> | undefined;

  switch (contentType) {
    case 'TEXT_CONTENT': {
      const body = typeof content?.body === 'string' ? content.body : '';
      const translated =
        typeof content?.bodyTranslated === 'string' ? content.bodyTranslated : '';
      // Prefer original body; translation is captured but not used for routing.
      return { kind: 'user', text: body || translated };
    }
    case 'MEDIA_CONTENT': {
      const items = Array.isArray(content?.mediaItems) ? content.mediaItems : [];
      const uris: string[] = [];
      for (const itemUnknown of items) {
        const item = itemUnknown as Record<string, unknown> | null;
        if (typeof item?.uri === 'string') uris.push(item.uri);
      }
      return {
        kind: 'user',
        text: uris.length ? `[media: ${uris.join(' | ')}]` : '[media]',
        mediaUris: uris,
      };
    }
    case 'VIEWER_BASED_CONTENT': {
      // accountType is typically SERVICE here; classify as system regardless.
      const body = typeof content?.body === 'string' ? content.body : '';
      const linkText = typeof content?.linkText === 'string' ? content.linkText : '';
      const text = [body, linkText].filter(Boolean).join(' — ');
      return { kind: 'system', text: text || `[viewer_based:${contentSubType}]` };
    }
    case 'TEMPLATE_CONTENT': {
      // accountType is USER (alteration requests). Pull primary text out of the
      // tombstoneHeader/kicker layout per probe shape.
      const headerV2 = content?.headerV2 as Record<string, unknown> | undefined;
      const tombstone = headerV2?.tombstoneHeader as Record<string, unknown> | undefined;
      const title = tombstone?.title as Record<string, unknown> | undefined;
      const titleBody = typeof title?.body === 'string' ? title.body : '';
      const kicker = tombstone?.kicker as Record<string, unknown> | undefined;
      const kickerBody = typeof kicker?.body === 'string' ? kicker.body : '';
      const text = [kickerBody, titleBody].filter(Boolean).join(': ');
      // System-routing for non-USER alterations (Airbnb auto-confirmations).
      if (accountType === 'SERVICE') {
        return { kind: 'system', text: text || `[template:${contentSubType}]` };
      }
      return { kind: 'user', text: text || `[template:${contentSubType}]` };
    }
    case 'STATIC_BULLETIN_CONTENT':
      // Probe v3 captured this contentType but did not characterize the body
      // shape; emit a placeholder + diagnostic counter per spec §3 table fix
      // P1-L. Always classified as system (do NOT route to AI reply path).
      return {
        kind: 'system',
        text: `[bulletin:contentSubType:${contentSubType || 'unknown'}]`,
      };
    default:
      return {
        kind: 'placeholder',
        text: `[unsupported:contentType:${contentType || 'missing'}]`,
      };
  }
}

/**
 * Build the URL for a `ViaductGetThreadAndDataQuery` GET request.
 * Variables match the full set per spec §3 Operation B.
 */
export function buildThreadUrl(opts: {
  threadHash: string;
  globalThreadId: string;
  numRequestedMessages?: number;
  earliestCursor?: string | null;
}): string {
  const variables: Record<string, unknown> = {
    globalThreadId: opts.globalThreadId,
    numRequestedMessages: opts.numRequestedMessages ?? 50,
    originType: 'USER_INBOX',
    getLastReads: false,
    forceReturnAllReadReceipts: false,
    forceUgcTranslation: false,
    getThreadState: true,
    getParticipants: true,
    getInboxFields: true,
    getMessageFields: true,
    getInboxOnlyFields: false,
    getThreadOnlyFields: false,
    skipOldMessagePreviewFields: false,
    isNovaLite: false,
    mockThreadIdentifier: null,
    mockMessageTestIdentifier: null,
    mockListFooterSlot: null,
  };
  if (opts.earliestCursor) {
    variables.earliestCursor = opts.earliestCursor;
  }
  const extensions = {
    persistedQuery: { version: 1, sha256Hash: opts.threadHash },
  };
  const params = new URLSearchParams({
    operationName: 'ViaductGetThreadAndDataQuery',
    locale: 'en',
    currency: 'USD',
    variables: JSON.stringify(variables),
    extensions: JSON.stringify(extensions),
  });
  return `https://www.airbnb.com/api/v3/ViaductGetThreadAndDataQuery/${opts.threadHash}?${params.toString()}`;
}

/**
 * Pure validator + mapper for a `ViaductGetThreadAndDataQuery` response. Used
 * both at runtime (after fetch) and in unit tests against fixtures. Does NOT
 * perform cursor walking — that's `readThreadViaApi`'s job; this validates a
 * single response page and emits its messages.
 *
 * Invariants enforced (spec §2 + §4 step 4):
 *   - decode(response.threadData.id).raw === expected rawId (identity)
 *   - hostNumericId ∈ participants.edges[].node.accountId (host membership)
 *   - schema fingerprint paths exist
 *   - per-message: id decodes to Message:<numeric>, accountId in participants,
 *     not soft-deleted, parent in batch (else drop reaction)
 *   - sort messages by createdAtMs ASC
 */
export function validateThreadResponse(
  body: unknown,
  expectedRawId: string,
  hostNumericId: string,
  globalThreadId: string,
  threadHashUsed: string,
): ThreadValidationOutcome {
  const diag: ThreadDiagnostics = {
    rawId: expectedRawId,
    globalThreadId,
    threadHashUsed,
    schemaFingerprintOk: false,
    identityCheck: 'skip',
    hostMembership: 'missing',
    messagesReturned: 0,
    messagesEmitted: 0,
    droppedSoftDelete: 0,
    droppedOrphanReaction: 0,
    droppedSystem: 0,
    droppedSchema: 0,
    droppedOriginInvariant: 0,
    droppedUnknownPrefix: 0,
    droppedNonNumericId: 0,
    contentTypeCounts: {},
    hasOlder: false,
    hasNewer: false,
    earliestCursor: null,
    latestCursor: null,
  };

  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'schema_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }
  const root = body as Record<string, unknown>;

  if (Array.isArray(root.errors) && root.errors.length > 0) {
    return { ok: false, reason: classifyGraphqlErrors(root.errors), diagnostics: diag, rawCreatedAtMs: [] };
  }

  const data = root.data as Record<string, unknown> | undefined;
  const threadData = data?.threadData as Record<string, unknown> | undefined;
  if (!threadData) {
    return { ok: false, reason: 'schema_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }

  // Identity invariant: decoded threadData.id raw must equal expected.
  const responseId = threadData.id;
  if (typeof responseId !== 'string') {
    return { ok: false, reason: 'schema_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }
  let decoded: { prefix: string; raw: string };
  try {
    decoded = decodeRelayId(responseId);
  } catch {
    diag.identityCheck = 'mismatch';
    return { ok: false, reason: 'identity_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }
  if (
    !ALLOWED_THREAD_PREFIXES.includes(decoded.prefix as (typeof ALLOWED_THREAD_PREFIXES)[number]) ||
    decoded.raw !== expectedRawId
  ) {
    diag.identityCheck = 'mismatch';
    return { ok: false, reason: 'identity_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }
  diag.identityCheck = 'ok';

  // Host membership: hostNumericId must be among participants.
  // For a SINGLE thread that lacks the host, the spec says drop+continue at the
  // cycle-flow level — so the validator returns `thread_host_mismatch` (NOT
  // `wrong_host`, which is account-level cycle abort). The cycle scheduler is
  // responsible for promoting `thread_host_mismatch` to `wrong_host` only when
  // ALL threads in the cycle fail.
  const participants = threadData.participants as Record<string, unknown> | undefined;
  const partEdges = participants?.edges;
  if (!Array.isArray(partEdges)) {
    return { ok: false, reason: 'schema_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }
  const participantAccountIds = new Set<string>();
  for (const peUnknown of partEdges) {
    const pe = peUnknown as Record<string, unknown> | null;
    const peNode = pe?.node as Record<string, unknown> | undefined;
    if (typeof peNode?.accountId === 'string') {
      participantAccountIds.add(peNode.accountId);
    }
  }
  if (!participantAccountIds.has(hostNumericId)) {
    diag.hostMembership = 'missing';
    return { ok: false, reason: 'thread_host_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }
  diag.hostMembership = 'ok';

  // Schema fingerprint: messageData paths exist.
  const messageData = threadData.messageData as Record<string, unknown> | undefined;
  const messages = messageData?.messages;
  const cursors = messageData?.expandedCursorsSegment as Record<string, unknown> | undefined;
  if (!Array.isArray(messages) || !cursors) {
    return { ok: false, reason: 'schema_mismatch', diagnostics: diag, rawCreatedAtMs: [] };
  }
  diag.schemaFingerprintOk = true;
  // Track raw timestamps from EVERY message in the response (before any filtering)
  // so cursor-walk can decide based on actual page boundaries, not post-filter.
  const rawCreatedAtMs: number[] = [];
  diag.messagesReturned = messages.length;
  diag.hasOlder = messageData?.hasOlder === true;
  diag.hasNewer = messageData?.hasNewer === true;
  diag.earliestCursor =
    typeof cursors.earliestCursor === 'string' ? cursors.earliestCursor : null;
  diag.latestCursor = typeof cursors.latestCursor === 'string' ? cursors.latestCursor : null;

  // First pass: collect candidate messages with metadata, count contentTypes.
  type Candidate = {
    msgId: string; // numeric
    /** True when the source message had a non-empty parentMessageId field. */
    hasParentRef: boolean;
    /** Numeric form of parentMessageId if extractable; else null even when hasParentRef=true. */
    parentNumericId: string | null;
    createdAtMs: number;
    sender: 'host' | 'guest';
    extracted: MessageExtract;
    contentType: string;
  };
  const candidates: Candidate[] = [];
  const seenNumericIds = new Set<string>();

  for (const msgUnknown of messages) {
    const msg = msgUnknown as Record<string, unknown> | null;
    if (!msg) {
      diag.droppedSchema += 1;
      continue;
    }
    const idValue = msg.id;
    const opaqueId = msg.opaqueId;
    if (typeof idValue !== 'string' && typeof opaqueId !== 'string') {
      diag.droppedSchema += 1;
      continue;
    }
    // Decode message id: either base64 'Message:<numeric>' or fall back to opaqueId
    // ('$1$<numericId>$<timestamp>') if id missing — diagnostic event per spec §2.
    let numericId: string | null = null;
    if (typeof idValue === 'string') {
      try {
        const dec = decodeRelayId(idValue);
        if (
          !ALLOWED_MESSAGE_PREFIXES.includes(
            dec.prefix as (typeof ALLOWED_MESSAGE_PREFIXES)[number],
          )
        ) {
          diag.droppedUnknownPrefix += 1;
          continue;
        }
        if (!RAW_NUMERIC_ID.test(dec.raw)) {
          diag.droppedNonNumericId += 1;
          continue;
        }
        numericId = dec.raw;
      } catch {
        diag.droppedUnknownPrefix += 1;
        continue;
      }
    } else if (typeof opaqueId === 'string') {
      // Fallback: $1$<numeric>$<timestamp>
      const m = opaqueId.match(/^\$1\$(\d{6,})\$\d+$/);
      if (!m) {
        diag.droppedSchema += 1;
        continue;
      }
      numericId = m[1];
    }
    if (!numericId) {
      diag.droppedSchema += 1;
      continue;
    }

    // Schema fingerprint per-message: id, account.accountId, createdAtMs.
    const account = msg.account as Record<string, unknown> | undefined;
    const accountId = typeof account?.accountId === 'string' ? account.accountId : null;
    const accountType = typeof account?.accountType === 'string' ? account.accountType : '';
    const createdAtMsRaw = msg.createdAtMs;
    if (!accountId || typeof createdAtMsRaw !== 'string') {
      diag.droppedSchema += 1;
      continue;
    }
    const createdAtMs = Number(createdAtMsRaw);
    if (!Number.isFinite(createdAtMs)) {
      diag.droppedSchema += 1;
      continue;
    }
    // Record raw timestamp BEFORE any filter — cursor-walk uses this.
    rawCreatedAtMs.push(createdAtMs);

    // Origin invariant: USER messages MUST have accountId in thread participants.
    // SERVICE accountType is exempt — Airbnb's internal SERVICE accounts (e.g.
    // viewer-based notifications, alteration auto-confirmations) are never listed
    // as participants but are still valid messages. Probe 2026-04-26 confirmed
    // SERVICE accountIds are NOT in participants.edges. Spec §2 invariant
    // narrows accordingly.
    if (accountType !== 'SERVICE' && !participantAccountIds.has(accountId)) {
      diag.droppedOriginInvariant += 1;
      continue;
    }

    // Soft-delete: spec §2 — drop only when isSoftDelete=true AND deletedAtMs > 0.
    // A bare isSoftDelete=true with deletedAtMs=0 (or absent) is malformed; treat as
    // not-yet-tombstoned and let it through (downstream dedup catches the actual
    // delete event when it arrives).
    if (msg.isSoftDelete === true) {
      const deletedAtMsRaw = msg.deletedAtMs;
      const deletedAtMs =
        typeof deletedAtMsRaw === 'string' ? Number(deletedAtMsRaw) : Number(deletedAtMsRaw);
      if (Number.isFinite(deletedAtMs) && deletedAtMs > 0) {
        diag.droppedSoftDelete += 1;
        continue;
      }
    }

    // Count contentType regardless of dispatch outcome.
    const contentType = typeof msg.contentType === 'string' ? msg.contentType : 'unknown';
    diag.contentTypeCounts[contentType] = (diag.contentTypeCounts[contentType] ?? 0) + 1;

    const extracted = extractText(msg);
    if (extracted.kind === 'system' || extracted.kind === 'placeholder') {
      diag.droppedSystem += 1;
      continue;
    }

    // Sender per spec: SERVICE → already filtered as system; USER → host vs guest.
    if (accountType === 'SERVICE') {
      // Defensive: should have been caught as system above.
      diag.droppedSystem += 1;
      continue;
    }
    const sender: 'host' | 'guest' = accountId === hostNumericId ? 'host' : 'guest';

    // Parent reference for orphan-reaction drop check. We track BOTH:
    //   - hasParentRef: was parentMessageId set at all (=> message is a reply/reaction)
    //   - parentNumericId: best-effort decoded numeric id of the parent
    // If hasParentRef=true but parentNumericId is null OR not in batch → drop in
    // second pass. Using hasParentRef separately prevents shorter/exotic parent
    // formats from silently bypassing the orphan-drop rule.
    let hasParentRef = false;
    let parentNumericId: string | null = null;
    if (typeof msg.parentMessageId === 'string' && msg.parentMessageId) {
      hasParentRef = true;
      try {
        const pd = decodeRelayId(msg.parentMessageId);
        if (
          ALLOWED_MESSAGE_PREFIXES.includes(
            pd.prefix as (typeof ALLOWED_MESSAGE_PREFIXES)[number],
          ) &&
          /^\d+$/.test(pd.raw)
        ) {
          parentNumericId = pd.raw;
        }
      } catch {
        // Fall through to numeric-string fallback below.
      }
      if (parentNumericId === null && /^\d+$/.test(msg.parentMessageId)) {
        // Some Airbnb response variants send the parent as a raw numeric id.
        parentNumericId = msg.parentMessageId;
      }
    }

    candidates.push({
      msgId: numericId,
      hasParentRef,
      parentNumericId,
      createdAtMs,
      sender,
      extracted,
      contentType,
    });
    seenNumericIds.add(numericId);
  }

  // Second pass: drop reactions whose parent isn't in this batch (v0 spec §6).
  // Note: a "reaction" in this v0 sense is any message with a parentMessageId
  // pointing outside the current batch. Reaction-only emoji rows have a
  // parentMessageId (the message they react to). Reply-with-text also have a
  // parentMessageId, but text replies are still emittable as their own
  // ScrapedMessage. Per spec §6 v0 conservative cut: if parent missing in batch,
  // drop the row entirely. v1 will reconcile across cycles.
  const filtered: Candidate[] = [];
  for (const c of candidates) {
    if (c.hasParentRef) {
      const parentInBatch =
        c.parentNumericId !== null && seenNumericIds.has(c.parentNumericId);
      if (!parentInBatch) {
        diag.droppedOrphanReaction += 1;
        continue;
      }
    }
    filtered.push(c);
  }

  // Sort createdAtMs ASC, stable (preserve relative order within same-timestamp).
  filtered.sort((a, b) => a.createdAtMs - b.createdAtMs);

  const conversationAirbnbId = expectedRawId;
  const out: ScrapedMessage[] = filtered.map(c => ({
    airbnb_message_id: `airbnb-${c.msgId}`,
    content: c.extracted.text,
    sender: c.sender,
    timestamp: new Date(c.createdAtMs).toISOString(),
    conversation_airbnb_id: conversationAirbnbId,
  }));
  diag.messagesEmitted = out.length;

  return { ok: true, messages: out, diagnostics: diag, rawCreatedAtMs };
}

export interface ThreadReaderOptions {
  rawThreadId: string;
  globalThreadId: string;
  hostNumericId: string;
  threadHash: string;
  apiKey: string;
  clientVersion: string;
  numRequestedMessages?: number;
  /** Watermark (ms) below which the cursor walk stops. Default: walk only one page. */
  watermarkMs?: number;
  /** Cap on cursor walks per cycle, default 5 per spec §4 step 4. */
  maxCursorWalks?: number;
  randomBytes?: (size: number) => Buffer;
}

export type ThreadReadOutcome = ThreadValidationOutcome;

/**
 * v0.2 entry point. Fetches one thread (with cursor walks if needed),
 * returns sorted ScrapedMessages + diagnostics. Caller is responsible for:
 *   - authEpoch.ready check (spec §2 invariant 8)
 *   - mode-gating (this function fetches regardless of mode; v0.3 wrapper
 *     enforces shadow vs api emission paths)
 *   - aggregating across threads + handing the batch to the callback
 */
export async function readThreadViaApi(
  page: Page,
  opts: ThreadReaderOptions,
): Promise<ThreadReadOutcome> {
  const numRequestedMessages = opts.numRequestedMessages ?? 50;
  const maxCursorWalks = opts.maxCursorWalks ?? 5;
  const headers = buildApolloHeaders({
    apiKey: opts.apiKey,
    clientVersion: opts.clientVersion,
    rng: opts.randomBytes,
  });

  const accumulated: ScrapedMessage[] = [];
  // Track all message IDs we've already incorporated, across cursor pages —
  // used both for dedup and for orphan-reaction parent lookups (spec §6 fix:
  // batch = all aggregated pages, not a single response).
  const seenIds = new Set<string>();
  const rawAggregateCreatedAtMs: number[] = [];
  let mergedDiag: ThreadDiagnostics | null = null;
  let cursor: string | null = null;
  let walks = 0;

  while (true) {
    const url = buildThreadUrl({
      threadHash: opts.threadHash,
      globalThreadId: opts.globalThreadId,
      numRequestedMessages,
      earliestCursor: cursor,
    });

    type FetchOutcome =
      | { kind: 'json'; body: unknown }
      | { kind: 'auth_http'; status: number }
      | { kind: 'http_error'; status: number; bodyText?: string }
      | { kind: 'non_json'; status: number };

    let outcome: FetchOutcome;
    try {
      outcome = (await page.evaluate(
        async ({ url, headers }) => {
          const res = await fetch(url, { headers, credentials: 'include' });
          const status = res.status;
          if (status === 401 || status === 403) {
            return { kind: 'auth_http', status };
          }
          if (status < 200 || status >= 300) {
            // Capture body for 404 PQNF detection (spec §4 failure modes:
            // PERSISTED_QUERY_NOT_FOUND can come back as 404 OR as 200+errors[]).
            // Cap body length to keep hard rule "never log full bodies" honored;
            // we only inspect the prefix for PQNF marker.
            const text = await res.text().catch(() => '');
            return { kind: 'http_error', status, bodyText: text.slice(0, 1024) };
          }
          const text = await res.text();
          try {
            return { kind: 'json', body: JSON.parse(text) };
          } catch {
            return { kind: 'non_json', status };
          }
        },
        { url, headers },
      )) as FetchOutcome;
    } catch {
      return makeFailedThreadOutcome('http_error', opts);
    }

    if (outcome.kind === 'auth_http' || outcome.kind === 'non_json') {
      return makeFailedThreadOutcome('cookie_invalid', opts);
    }
    if (outcome.kind === 'http_error') {
      // Spec §4: HTTP 404 with PERSISTED_QUERY_NOT_FOUND body → trigger hash
      // recovery, not generic http_error.
      if (outcome.status === 404 && outcome.bodyText) {
        try {
          const parsed = JSON.parse(outcome.bodyText) as Record<string, unknown>;
          const errs = parsed.errors;
          if (Array.isArray(errs) && classifyGraphqlErrors(errs) === 'persisted_query_not_found') {
            return makeFailedThreadOutcome('persisted_query_not_found', opts);
          }
        } catch {
          // Not JSON; fall through.
        }
        if (
          outcome.bodyText.includes('PersistedQueryNotFound') ||
          outcome.bodyText.includes('PERSISTED_QUERY_NOT_FOUND')
        ) {
          return makeFailedThreadOutcome('persisted_query_not_found', opts);
        }
      }
      return makeFailedThreadOutcome('http_error', opts);
    }

    const validated = validateThreadResponse(
      outcome.body,
      opts.rawThreadId,
      opts.hostNumericId,
      opts.globalThreadId,
      opts.threadHash,
    );
    if (!validated.ok) {
      return validated;
    }

    // Detect cross-page overlap: any message id in the new page already in our
    // accumulated set. Per spec §4 step 4 termination condition (a) "message
    // older than watermark observed (overlap)", we stop walking once overlap
    // is detected. This is independent of the watermark check — overlap means
    // the cursor has wrapped or repeated, and continuing won't add new history.
    let overlapDetected = false;
    for (const m of validated.messages) {
      if (seenIds.has(m.airbnb_message_id)) {
        overlapDetected = true;
      } else {
        seenIds.add(m.airbnb_message_id);
        accumulated.push(m);
      }
    }
    rawAggregateCreatedAtMs.push(...validated.rawCreatedAtMs);
    mergedDiag = mergeThreadDiagnostics(mergedDiag, validated.diagnostics);

    // Cursor-walk gating per spec §4 step 4:
    //   (a) page is full (length === numRequestedMessages on the RAW response —
    //       NOT post-filter; an all-system page can still have older user msgs
    //       behind it).
    //   (b) hasOlder === true on the response.
    //   (c) earliestCursor present.
    //   (d) walks < cap.
    //   (e) oldest of RAW page > watermark (or no watermark).
    //   (f) NO overlap with previously-seen ids.
    const rawOldest =
      validated.rawCreatedAtMs.length > 0
        ? validated.rawCreatedAtMs.reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY)
        : null;
    const watermark = opts.watermarkMs ?? null;
    const shouldWalk =
      validated.diagnostics.messagesReturned >= numRequestedMessages &&
      validated.diagnostics.hasOlder &&
      validated.diagnostics.earliestCursor !== null &&
      walks < maxCursorWalks &&
      rawOldest !== null &&
      (watermark === null || rawOldest > watermark) &&
      !overlapDetected;
    if (!shouldWalk) break;
    cursor = validated.diagnostics.earliestCursor;
    walks += 1;
  }

  // Final sort by timestamp ASC. Dedup happened inline during accumulation.
  const sorted = [...accumulated].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );

  return {
    ok: true,
    messages: sorted,
    diagnostics: mergedDiag ?? makeEmptyThreadDiagnostics(opts),
    rawCreatedAtMs: rawAggregateCreatedAtMs,
  };
}

function makeEmptyThreadDiagnostics(opts: ThreadReaderOptions): ThreadDiagnostics {
  return {
    rawId: opts.rawThreadId,
    globalThreadId: opts.globalThreadId,
    threadHashUsed: opts.threadHash,
    schemaFingerprintOk: false,
    identityCheck: 'skip',
    hostMembership: 'missing',
    messagesReturned: 0,
    messagesEmitted: 0,
    droppedSoftDelete: 0,
    droppedOrphanReaction: 0,
    droppedSystem: 0,
    droppedSchema: 0,
    droppedOriginInvariant: 0,
    droppedUnknownPrefix: 0,
    droppedNonNumericId: 0,
    contentTypeCounts: {},
    hasOlder: false,
    hasNewer: false,
    earliestCursor: null,
    latestCursor: null,
  };
}

function makeFailedThreadOutcome(
  reason: InboxFailureReason,
  opts: ThreadReaderOptions,
): ThreadReadOutcome {
  return { ok: false, reason, diagnostics: makeEmptyThreadDiagnostics(opts), rawCreatedAtMs: [] };
}

function mergeThreadDiagnostics(
  prev: ThreadDiagnostics | null,
  next: ThreadDiagnostics,
): ThreadDiagnostics {
  if (!prev) return { ...next, contentTypeCounts: { ...next.contentTypeCounts } };
  return {
    rawId: next.rawId,
    globalThreadId: next.globalThreadId,
    threadHashUsed: next.threadHashUsed,
    schemaFingerprintOk: prev.schemaFingerprintOk && next.schemaFingerprintOk,
    identityCheck: prev.identityCheck === 'ok' ? next.identityCheck : prev.identityCheck,
    hostMembership: prev.hostMembership === 'ok' ? next.hostMembership : prev.hostMembership,
    messagesReturned: prev.messagesReturned + next.messagesReturned,
    messagesEmitted: prev.messagesEmitted + next.messagesEmitted,
    droppedSoftDelete: prev.droppedSoftDelete + next.droppedSoftDelete,
    droppedOrphanReaction: prev.droppedOrphanReaction + next.droppedOrphanReaction,
    droppedSystem: prev.droppedSystem + next.droppedSystem,
    droppedSchema: prev.droppedSchema + next.droppedSchema,
    droppedOriginInvariant: prev.droppedOriginInvariant + next.droppedOriginInvariant,
    droppedUnknownPrefix: prev.droppedUnknownPrefix + next.droppedUnknownPrefix,
    droppedNonNumericId: prev.droppedNonNumericId + next.droppedNonNumericId,
    contentTypeCounts: mergeCounts(prev.contentTypeCounts, next.contentTypeCounts),
    hasOlder: next.hasOlder,
    hasNewer: prev.hasNewer || next.hasNewer,
    earliestCursor: next.earliestCursor,
    latestCursor: prev.latestCursor ?? next.latestCursor,
  };
}

function mergeCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

void KNOWN_CONTENT_TYPES; // exported indirectly via extractText behavior; reserved for v0.3 telemetry
