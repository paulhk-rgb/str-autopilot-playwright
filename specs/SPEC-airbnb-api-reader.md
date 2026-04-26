# SPEC: Airbnb Persisted-GraphQL Inbox Reader

> **STATUS: SUPERSEDED — DO NOT IMPLEMENT.**
>
> This is v0 of the spec. Current authoritative spec is [SPEC-airbnb-api-reader-v2.md](./SPEC-airbnb-api-reader-v2.md) (v2.1 with audit-applied patches).
>
> **What changed v0 → v2.1:**
> - `dual` mode REMOVED (replaced with `shadow` mode that emits to a diagnostic side channel only — UI mode remains sole callback emitter during shadow). v0's `dual` mode caused mark-as-read API calls to pollute UI state.
> - GlobalThreadId is now ALWAYS extracted from API response, NEVER constructed from raw IDs (v0 said "construct"; v2 says response-only).
> - `Message.id` documented as base64-opaque (decodes to `Message:<numericId>` Relay format), not numeric. UI/API equivalence gate is decoded-numeric, not byte-equivalent.
> - 12-header forward set documented; bare fetch returns 400.
> - AuthEpoch lock added to couple `/inject-cookies` to read cycle.
> - Trace-ID generator uses rejection sampling (v0 had a broken implementation).
> - Many other contradictions resolved per audit logs in v2.1 header.
>
> If you read this file and start implementing, STOP and switch to v2.

**Status:** SUPERSEDED v0 (kept for history)
**Created:** 2026-04-26
**Replaced by:** [SPEC-airbnb-api-reader-v2.md](./SPEC-airbnb-api-reader-v2.md)
**Depends on:** Authenticated Airbnb host browser session (Playwright Chromium on Fly)

---

## 1. Problem & Goal

The current sidecar reads Airbnb host messages by navigating the inbox SPA and parsing rendered DOM rows. SPA thread navigation is unreliable headless on Fly: timeouts, stale-DOM, and zero-result reads. The existing UI patch on `codex/scraper-thread-nav-safety` improves robustness but cannot reliably switch threads in production.

**Goal:** Replace the UI thread-iteration with direct calls to Airbnb's internal persisted GraphQL inbox API, observed via a sanitized CDP probe (2026-04-26).

**Definition of done:**

- All threads in the host inbox are read each cycle (subject to a configurable cap), not just the first auto-loaded one.
- Each thread's full message history (subject to page cap, with cursor-based extension) is read.
- Existing `ScrapedMessage` shape and StaySync `/api/playwright-callback` contract are unchanged.
- Existing dedup behavior (`messageId = airbnb-${...}`) is preserved.
- Production stays on the known-good image until a candidate passes typecheck, unit tests, sandbox sync, and a controlled Fly canary.
- No wrong-thread or stale-thread messages are emitted to the callback.

---

## 2. Domain Model

### Bounded context

The reader owns *fetch* and *normalization*. It does not own *send* (that remains the StaySync callback path). It does not own *auth* (that remains cookie-injection via `/inject-cookies`).

### Aggregates & value objects

#### `RawThreadId`
- Numeric string from inbox sidebar `data-testid="inbox_list_<rawId>"`, e.g. `"2476957479"`.
- **Invariant:** non-empty digits only. Reject anything else.

#### `GlobalThreadId`
- Opaque base64 string used by the API.
- **Encoding:** `base64("MessageThread:" + RawThreadId)`. Verified via probe.
- **Invariant:** decoding must yield the literal prefix `"MessageThread:"` followed by the same `RawThreadId`. If not, fail closed.
- Helper: `globalThreadIdFor(rawId): string` and `rawIdFromGlobal(global): string`.

#### `MessageThread` (aggregate root)
- Identity: `RawThreadId` (canonical) ↔ `GlobalThreadId` (API token).
- Contains: ordered list of `Message`, optional `Cursor` for older history.
- `participants[]` (host + guest) used to classify message direction.

#### `Message` (entity)
- Identity: API field `id` (or `opaqueId` if `id` absent).
- Sidecar-emitted ID: `airbnb-<messageId>` — same shape as today, dedup-compatible.
- Fields used: `id`, `createdAtMs`, `updatedAtMs`, `deletedAtMs`, `account.{accountId,accountType}`, `hydratedContent`, `contentType`, `contentSubType`, `parentMessageId`, `reactionSummary`.
- **Invariant — origin:** `account.accountId` must equal one of the thread's `participants[].node.accountId`. If not, drop message and log diagnostic.

#### `Cursor`
- Opaque string from `expandedCursorsSegment.earliestCursor` / `latestCursor`.
- Used to extend a single thread's history beyond `numRequestedMessages` cap.

### Invariants (system-level)

1. **Thread identity match:** `decode(globalThreadIdRequested) == decode(response.data.threadData.id)`. Any mismatch → drop entire response, emit diagnostic, do not call callback.
2. **Cookie validity:** if any GraphQL call returns 401/403 *or* an HTML login redirect body, abort the run, set `cookie_valid=false`, do not call callback.
3. **Hash rotation:** persisted query hashes (the path suffix) are server-pinned. If a hash returns 404 or a `PERSISTED_QUERY_NOT_FOUND` error, fall back to a configurable secondary path: either (a) re-run the probe to learn the new hash, or (b) bail out for the cycle and alert. **Hash refresh is out of scope for v0** — store as env, manual refresh.
4. **Page cap:** at most `numRequestedThreads` (default 15) inboxes per cycle; at most `numRequestedMessages` (default 50) messages per thread per cycle. Older messages walked via cursor only when an empty-tail dedup pass shows missing IDs.
5. **No raw secret in logs:** cookies, full URLs with `variables=`, and message bodies are NEVER logged. Diagnostics log operation name, hash prefix, status, and counts only.

---

## 3. External API Contract (Observed)

### Endpoint pattern

```
GET https://www.airbnb.com/api/v3/<OperationName>/<persistedQueryHash>
  ?operationName=<OperationName>
  &locale=en
  &currency=USD
  &variables=<urlencoded JSON>
  &extensions=<urlencoded JSON containing persistedQuery hash>
```

Auth: Airbnb session cookies (`_aat`, `_user_attributes`, etc.) attached automatically by browser context.

### Operation A — `ViaductInboxData` (inbox listing)

- **Path:** `/api/v3/ViaductInboxData/ebeb240346015c12...` (full hash captured in code; treat as env-pinned).
- **Variables (used):**
  - `userId` (required) — `base64("Viewer:" + numericUserId)`. We already know `userId=50758264`, so this is a constant per host.
  - `numRequestedThreads`: 15
  - `numPriorityThreads`: 2
  - `originType`: `"USER_INBOX"`
  - `threadVisibility`: `"UNARCHIVED"` (also: `"ARCHIVED"`, `"REQUEST"` — see §6)
  - `getParticipants`, `getInboxFields`, `getMessageFields`, etc. — boolean field-expansion flags. Default to all `true` for v0.
- **Response path of interest:**
  - `data.node.messagingInbox.inboxItems.edges[].node` — each thread (Relay node)
  - `data.node.messagingInbox.inboxItems.pageInfo.{startCursor,endCursor,hasNextPage,hasPreviousPage}` — Relay pagination

### Operation B — `ViaductGetThreadAndDataQuery` (single thread + messages)

- **Path:** `/api/v3/ViaductGetThreadAndDataQuery/9384287931cf3da6...`
- **Variables (used):**
  - `globalThreadId` — `base64("MessageThread:" + rawId)`
  - `numRequestedMessages`: 50
  - `originType`: `"USER_INBOX"`
  - `getThreadState`, `getParticipants`, `getLastReads`, `getMessageFields`, `forceUgcTranslation`, `forceReturnAllReadReceipts`, `isNovaLite`, etc. — booleans, default per probe capture.
- **Response path of interest:**
  - `data.threadData.id` — must decode to expected raw thread ID (invariant 1)
  - `data.threadData.messageData.messages[]` — actual message list
  - `data.threadData.messageData.{hasOlder, hasNewer, upToDate}` — pagination flags
  - `data.threadData.messageData.expandedCursorsSegment.{earliestCursor, latestCursor}` — cursors for extending
  - `data.threadData.participants.edges[].node` — host + guest profile
  - `data.threadData.orderedParticipants[]` — simpler `{accountId, accountType}` pair

### Inputs persisted as Script Properties / env

- `AIRBNB_API_INBOX_HASH=ebeb240346015c12...`
- `AIRBNB_API_THREAD_HASH=9384287931cf3da6...`
- `AIRBNB_API_USER_ID=50758264` (already known)
- `AIRBNB_API_GLOBAL_USER_ID=Vmlld2VyOjUwNzU4MjY0` (precomputed from above)

Hashes pinned. Refresh by re-running probe and updating env. v0 does not auto-rotate.

---

## 4. Implementation Strategy

### Module: `src/playwright/api-reader.ts` (new)

Public function:

```ts
export async function readInboxViaApi(
  page: Page,
  opts: ReadInboxOptions
): Promise<ScrapedMessage[]>
```

Internally:

1. **Step A — list threads.** Call `ViaductInboxData` via `page.evaluate(async () => fetch(...))` so cookies + same-origin policy are inherited from the existing browser context. No header forwarding needed.
2. **Step B — per thread.** For each `RawThreadId` in the inbox response (capped at `numRequestedThreads`), compute `globalThreadId`, call `ViaductGetThreadAndDataQuery`. Verify identity invariant (1).
3. **Step C — map.** For each message in the thread's `messageData.messages[]`, build `ScrapedMessage`:
   - `messageId = "airbnb-" + msg.id`
   - `threadId = rawIdFromGlobal(threadData.id)`
   - `senderAccountId = msg.account.accountId`
   - `direction = senderAccountId === ownAccountId ? "host" : "guest"`
   - `text = extractText(msg.hydratedContent)` — handler for plain + rich text. Treat unknown content types as opaque markers (`[unsupported]`) but still emit a row so dedup tracks them.
   - `createdAtMs = parseInt(msg.createdAtMs, 10)`
   - Skip if `isSoftDelete === true` and `deletedAtMs > 0`.
4. **Step D — emit.** Return flat `ScrapedMessage[]` to the existing send loop. Do not change callback.

### Why `page.evaluate(fetch())` and not direct node-fetch with cookies?

- Avoids extracting/forwarding cookies, which requires touching `src/lib/env.ts` (forbidden) and reduces credential blast radius.
- Same TLS fingerprint as the current SPA, less likely to trigger PerimeterX-like challenges (`d0a7e.airbnb.com` was observed during the probe on uncredentialed pages).
- Keeps a single auth source of truth: the Playwright context.

### `extractText(hydratedContent)`

Single normalization point. `hydratedContent` shape was not fully sampled in the probe (depth-truncated at the typed sample). v0 must:

- Run a one-off targeted probe to capture `hydratedContent` shapes for plaintext, rich text, system, RTB, and reaction-only messages — *with explicit Paul opt-in*, since this is the first content shape we'd dump.
- Until then, fall back to the current UI parser for v0.5 *only* for `extractText`, and run API-reader behind a feature flag `INBOX_READER_MODE=api|ui` (default `ui`).

### Feature flag

`INBOX_READER_MODE`:
- `ui` (default): existing behavior unchanged.
- `api`: new path; UI parser is dead code for the cycle.
- `dual`: run both, log discrepancies (no callback diff), promote when stable.

### Failure modes

| Trigger | Action |
|---|---|
| `ViaductInboxData` 401/403 or HTML body | set `cookie_valid=false`, abort cycle, no callback |
| `PERSISTED_QUERY_NOT_FOUND` (any op) | warn, fall back to `INBOX_READER_MODE=ui` for that cycle, alert |
| Identity mismatch on `ViaductGetThreadAndDataQuery` | drop that thread's payload, continue with others, log diagnostic |
| Network timeout | retry once with 2s backoff; on second failure, skip thread, continue cycle |
| `messageData.messages.length === 0` | emit zero rows for that thread (legitimate empty thread), do not error |
| `numRequestedMessages` cap hit (length === 50 *and* `hasOlder === true`) | for v0, log a diagnostic and rely on dedup at the callback. v1 walks `earliestCursor`. |

---

## 5. Diagnostics

Augment `__lastInboxDiag` with API-reader fields:

```ts
{
  mode: "ui" | "api" | "dual",
  api: {
    inboxHash: "ebeb240346015c12...",   // first 16 chars only
    threadHash: "9384287931cf3da6...",
    threadsRequested: 15,
    threadsReturned: <n>,
    perThread: [{
      rawId: "2476957479",
      globalIdMatch: true,
      messagesReturned: 14,
      hasOlder: false,
      identityCheck: "ok" | "mismatch" | "skip",
    }],
    totalMessagesEmitted: 27,
    elapsedMs: 4231
  },
  fallbacks: { ... },                    // any UI-mode fallback this cycle
}
```

No URLs, no cookies, no hydratedContent. Counts and identity assertions only.

---

## 6. Out of Scope (v0)

- Archived inbox (`threadVisibility=ARCHIVED`) — v1.
- Booking-request inbox (`threadVisibility=REQUEST`) — v1.
- `SyncProtocolSubscription` real-time channel — v2 (replaces polling entirely).
- Automatic persisted-query hash rotation — v1.
- Message text rich rendering parity with the UI — v0.5 reuses UI extractor.

---

## 7. Test Strategy

### Unit (`tests/api-reader-mapping.test.ts`)

- `globalThreadIdFor("2476957479") === "TWVzc2FnZVRocmVhZDoyNDc2OTU3NDc5"`
- `rawIdFromGlobal("TWVzc2FnZVRocmVhZDoyNDc2OTU3NDc5") === "2476957479"`
- Identity invariant — fixture with mismatched IDs is rejected.
- Soft-delete is dropped.
- Reaction-only message emits a row with explicit type (no body).
- Unknown content type emits a placeholder row (does not throw).

### Integration (`tests/api-reader-flow.test.ts`)

- Stub `page.evaluate(fetch)` returns canned ViaductInboxData + ViaductGetThreadAndDataQuery responses (sanitized fixtures generated from the deep probe).
- Assert: 2 inbox threads → 2 thread fetches → mapped messages count matches fixture.
- Assert: feature flag `dual` runs both paths and emits a discrepancy log without changing callback output.

### Live canary (manual, gated)

1. Local sandbox sync (`npm run sync` or equivalent) with `INBOX_READER_MODE=dual`. Confirm zero discrepancies for ≥3 cycles.
2. Build candidate Fly image. Deploy to `str-autopilot-playwright` with `INBOX_READER_MODE=dual`. Watch DB counts for ≥1 hour: `messages` strictly increases or stays flat, never duplicates.
3. Promote to `INBOX_READER_MODE=api` by env flip — no redeploy.
4. Rollback path: `INBOX_READER_MODE=ui` env flip.

---

## 8. ADRs

### ADR-001: persisted GraphQL over UI scrape
- **Context:** UI thread navigation unreliable in headless Fly. UI parser proven correct on auto-loaded thread but cannot enumerate.
- **Decision:** call internal persisted-query GraphQL endpoints discovered via sanitized CDP probe.
- **Rationale:** stable hashes (verified across 3 probe runs), Relay-style pagination with explicit cursors, identity-checkable response (`data.threadData.id` decodes to raw thread ID).
- **Consequence:** new failure mode (hash rotation) needs alerting + manual refresh path in v0.

### ADR-002: `page.evaluate(fetch)` over node-fetch with cookie forwarding
- **Context:** must call authenticated Airbnb endpoints from sidecar.
- **Decision:** issue `fetch()` from inside the existing Playwright page context.
- **Rationale:** no cookie extraction, no `env.ts` change, no new credential surface, matches SPA TLS fingerprint.
- **Consequence:** depends on a healthy logged-in `page`; reuses existing keepalive logic.

### ADR-003: feature flag `INBOX_READER_MODE` with `dual` mode
- **Context:** must promote without breaking production.
- **Decision:** ship `ui` (default), `api`, and `dual` (run-both, compare-only).
- **Rationale:** dual mode lets us validate live without callback risk; flag flip rollback in seconds.
- **Consequence:** small runtime cost during dual; remove `dual` once stable for ≥1 week.

---

## 9. Open Questions for Review

1. `hydratedContent` shape — should we capture in a follow-up probe, or freeze v0 as UI-extractor-shim only?
2. Thread cap: is 15/cycle enough for the host's volume, or should we paginate inbox via `endCursor` in v0?
3. Hash rotation alerting: where does the alert go? StaySync? log-only?
4. Do we want to walk older messages via `earliestCursor` in v0, or accept the 50-msg-per-thread cap and rely on dedup?
5. `Viewer:` ID — do we need to handle multi-host sessions, or is sidecar always single-host per Fly app?
