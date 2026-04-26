/**
 * Airbnb persisted-GraphQL inbox reader (v0.1 scaffold).
 *
 * Replaces UI-parser thread navigation in scrape-inbox.ts with direct calls to
 * Airbnb's `ViaductInboxData` and `ViaductGetThreadAndDataQuery` persisted-query
 * endpoints. v0.1 ships the inbox-listing path + ID extraction + invariants only;
 * thread-read + extractors land in v0.2; shadow comparator in v0.3; cutover in v0.4.
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
 * Discriminator for failed inbox reads. Each reason maps to a distinct caller
 * action per spec §4 failure-modes table:
 *   - cookie_invalid          → set `cookie_valid=false`, abort cycle, surface alert.
 *   - persisted_query_not_found → trigger hash auto-recovery (mode-gated reload).
 *   - wrong_host              → set `cookie_valid=false`, abort cycle (cookies are for
 *                               a different host).
 *   - schema_mismatch         → log diagnostic, abort cycle, alert (Airbnb shipped a
 *                               GraphQL schema change we don't recognize).
 *   - http_error              → transport/network failure (timeout, DNS, TLS,
 *                               execution-context-destroyed). Retry next cycle.
 */
export type InboxFailureReason =
  | 'cookie_invalid'
  | 'persisted_query_not_found'
  | 'wrong_host'
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
    | { kind: 'http_error'; status: number } // other non-2xx
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
          return { kind: 'http_error', status };
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
    case 'http_error':
      return { ok: false, reason: 'http_error', diagnostics: emptyDiag() };
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
