# SPEC: Airbnb Persisted-GraphQL Inbox Reader (v2)

**Status:** Draft v2 — supersedes v1 (self-review found 9 issues, all addressed below)
**Created:** 2026-04-26
**Replaces:** UI-parser thread navigation in `src/playwright/scrape-inbox.ts`
**Depends on:** Authenticated Airbnb host browser session (Playwright Chromium on Fly)
**Reviewed:**
- 2026-04-26 — 3-model adversarial debate (Opus 4.7, Gemini 3.1 Pro Preview, Codex GPT-5.5). See [DEBATE-airbnb-api-reader.md](./DEBATE-airbnb-api-reader.md).
- 2026-04-26 — v1 self-review surfaced P1-A (SPA hash refresh), P1-B (SPA build hash extraction speculative), P1-C (hash-alert path), P1-D (listing routing — confirmed existing limitation), P2-E through P2-H. v2 patches all 9.
- 2026-04-26 — pre-implementation cold review (Opus 4.7) + live API probe surfaced P0-J (broken trace-ID generator), P0-K (UI/API ID byte-equivalence is impossible — encodings differ; gate must be decoded-equivalence), P1-L (5th `contentType` `STATIC_BULLETIN_CONTENT` observed), P1-M (`data/watermarks.json` ephemeral on Fly without volume mount), P2-N (`authEpoch.ready` not in cycle-flow checklist), P2-O (`Message:` prefix allow-list missing parallel to `MessageThread:`). v2.1 patches inline below.

**Confirmed StaySync callback contract (read-only inspection 2026-04-26):**
- Endpoint: `POST /api/playwright-callback`, `action=sync_messages_batch`.
- Batch dedup primitive: `external_message_id` per `(host_id, channel='playwright', external_message_id)` UNIQUE partial index (`idx_msg_dedup_external`, migration 006).
- Conversation attachment: callback resolves to host's FIRST ACTIVE property via `resolveFallbackPropertyId()` — sidecar does NOT send `listing_id`. Same behavior as current UI mode. Per-listing routing is a future spec; out of scope here.
- Sidecar must send: `airbnb_message_id` (= `external_message_id` after Postgres-side prefix), `conversation_airbnb_id` (= raw thread ID), `content`, `sender`, `timestamp`.

---

## 1. Problem & Goal

Sidecar reads Airbnb host messages by navigating the inbox SPA and parsing rendered DOM. Unreliable headless on Fly: timeouts, stale DOM, intermittent partial reads. UI-parser hardening branch (`codex/scraper-thread-nav-safety`) does not solve thread enumeration in production — the bug is in the SPA-navigation substrate, not the parser.

**Goal:** Replace UI iteration with direct calls to Airbnb's persisted GraphQL inbox API observed via sanitized CDP probes (2026-04-26).

**Definition of done:**

- All threads in the host inbox are read each cycle, capped at `numRequestedThreads` per cycle, plus cursor-walk for older messages when watermark gap detected.
- Existing `ScrapedMessage` shape and StaySync `/api/playwright-callback` contract are unchanged.
- Existing dedup behavior (`messageId = airbnb-${...}`) is preserved AND **decoded-numeric-equivalence** is proven in shadow mode for ≥3 days with 0 mismatches before any callback writes. UI extracts `data-item-id` as a numeric string (e.g., `30309676377`); API returns `messages[].id` as base64-encoded `Message:<numericId>` (e.g., `TWVzc2FnZTozMDMwOTY3NjM3Nw==`). Equivalence check: `base64Decode(api.id).startsWith("Message:") && base64Decode(api.id).slice("Message:".length) === ui.dataItemId`. Both sides emit identical `airbnb-${numericId}` strings to the callback so dedup is unaffected.
- No wrong-thread, stale-thread, or wrong-host messages are emitted.
- Production stays on the known-good UI image until shadow gates pass.

---

## 2. Domain Model

### Bounded context

Reader owns *fetch* and *normalization*. Auth (cookies) is owned by `/inject-cookies`. Send is owned by StaySync callback. The new boundary: **`authEpoch`** (a monotonic counter on the sidecar) couples the auth boundary to the read cycle so cookie rotation cannot split a cycle.

### Aggregates & value objects

#### `RawThreadId`
Numeric string. Validation: `/^\d{6,}$/`.

#### `GlobalThreadId`
Opaque base64 string. **Always extracted from API response** (`data.node.messagingInbox.inboxItems.edges[].node.id`). Never constructed from `RawThreadId`.

The base64 prefix decodes to a Relay node-type. Probe (2026-04-26) showed all 15 host inbox threads are `MessageThread:` prefix. Allow-list:

```
ALLOWED_THREAD_PREFIXES = ["MessageThread"]
```

Unknown prefix → **loud alert via the alert path defined in §5** (v0: pull-only via `/health` JSON; push to `/api/airbnb-system-events` deferred to a future release). Counter increments in `__lastInboxDiag.api.threadsDroppedUnknownPrefix`, never silently skipped. Do not crash — continue with the rest of the inbox. The existing `POST /api/playwright-callback` route is **not** used for this alert (its contract is sacred per §11 hard rules).

For diagnostic and consistency, also assert that `decode(node.id) === "MessageThread:" + extractedRawId`. Mismatch → drop thread + alert, do not callback.

#### `MessageThread` (aggregate)
- Identity: `RawThreadId` ↔ `GlobalThreadId` (response-extracted).
- Contains: ordered list of `Message` (sorted `createdAtMs ASC` before emission), pagination cursors, participants.
- **Invariant 1c (host-membership) — UPDATED for two-tier behavior per audit 2026-04-26 R2:**
  - **Per-thread:** `participants.edges[].node.accountId` MUST contain `AIRBNB_API_USER_ID`. If absent on a single thread → drop the thread, log diagnostic, **continue cycle with remaining threads** (the thread may have been re-assigned, demoted, or stale). Single per-thread misses are not auth failures.
  - **Cycle-wide:** if NO inbox thread (`inboxItems.edges.length > 0`) contains `AIRBNB_API_USER_ID` in any participant — i.e. all threads fail the per-thread check — cookies are for the wrong host → fail closed (`cookie_valid=false`, abort cycle, no callback).
  - **Brand-new host edge case:** `inboxItems.edges.length === 0` (legitimate empty inbox) passes — known limitation per ADR-006.
  - This unifies the previously-conflicting language in §2 (was "abort") and §4 step 4 / failure-mode table (was "drop + continue") onto a coherent two-tier rule. See §4 step 4 + Failure Modes table for the matching cycle-flow logic.

#### `Message` (entity)
- Identity: API field `id` is **base64-opaque** (probe-confirmed: 28 chars, decodes to `Message:<numericId>` Relay node-ID format). Numeric `messageId` is recovered via `base64Decode(id).slice("Message:".length)` after prefix check. Fall back to parsing `opaqueId` (format `$1$<numericId>$<timestampMs>`) if `id` absent — emit diagnostic event.
- **Message-prefix allow-list (P2-O fix, parallel to MessageThread):**
  ```
  ALLOWED_MESSAGE_PREFIXES = ["Message"]
  ```
  Decoded prefix not in allow-list → drop message + loud alert. Don't crash. Don't silently emit unknown-typed nodes (e.g., `Reaction:`, `SystemNotice:`) as if they were messages.
- Sidecar-emitted ID: `airbnb-${numericId}` — same shape as today (UI emits same).
- Fields: `id` (base64), `uuid`, `opaqueId`, `account.{accountId,accountType}`, `hydratedContent`, `contentType`, `contentSubType`, `createdAtMs` (string-typed milliseconds, parse with care for >2^53), `updatedAtMs`, `deletedAtMs`, `editedAtMs`, `isSoftDelete`, `parentMessageId`, `reactionSummary`, `syncCursor`.
- **Invariant — origin:** `account.accountId` must equal one of the thread's `participants.edges[].node.accountId`. Else drop message + diagnostic.
- **Soft-delete:** if `isSoftDelete === true` and `deletedAtMs > 0`, do NOT emit (v0). v1 may emit tombstone with separate `messageId` suffix.

#### `Cursor`
Opaque from `data.threadData.messageData.expandedCursorsSegment.{earliestCursor, latestCursor}`. Used to walk older messages when `messages.length === numRequestedMessages && hasOlder === true && watermark gap detected`.

#### `Watermark` (per-thread, sidecar-local)
Persistent file `data/watermarks.json`: `{ rawThreadId: latestEmittedCreatedAtMs }`. Updated **after** successful callback ack. Used to detect cursor-walk-needed.

**Persistence on Fly (P1-M fix).** Verified 2026-04-26: `fly.toml` has no `[mounts]` block. `data/` is on the rootfs (`/app/data/`), which is **ephemeral on machine restart**. Implications:
1. **Cold start = empty watermarks** → first cycle after a restart treats every thread as new, capping at `numRequestedMessages=50` per thread, NOT triggering cursor-walk (cursor-walk requires a prior watermark to detect a gap).
2. Dedup is enforced at the StaySync DB layer (`idx_msg_dedup_external` partial UNIQUE on `(host_id, channel='playwright', external_message_id)`, migration 006) — re-emitting on a cold start is safe; duplicates collapse server-side. The watermark is a perf optimization (skip-already-emitted), not a correctness gate.
3. **Recommended:** add a Fly volume mount under `[mounts]` in `fly.toml` for `/app/data/` to preserve watermarks across machine recycles. Until then, accept ephemerality.
4. Reader MUST be defensive: missing/empty/corrupt `data/watermarks.json` → start fresh with empty map, log diagnostic, do not crash.

#### `AuthEpoch` (sidecar-global)
Monotonic counter. Bumped by `/inject-cookies`. Reader records pre-cycle, aborts pre-emission if changed.

### System invariants

1. **Thread identity:** decode(globalThreadIdRequested) === decode(response.data.threadData.id). Mismatch → drop thread.
2. **Cookie validity:** GraphQL `errors[]` with auth-related codes, OR HTTP 401/403, OR HTML body, OR PerimeterX/Datadome JSON challenge body → set `cookie_valid=false`, abort, no callback.
3. **Hash health:** schema-fingerprint check per cycle. Required paths must be present in response. See §4.
4. **Page caps:** 15 threads/cycle, 50 messages/thread/cycle, plus cursor-walk per watermark gap.
5. **No raw secret in logs.** Cookies, full URLs (which contain `variables=`), and message bodies NEVER logged. Diagnostics log operation name, hash prefix, status, counts only.
6. **Host-membership** (per §2 `MessageThread`).
7. **AuthEpoch consistency:** if `authEpoch` at emit-time != `authEpoch` at cycle-start → abort emission.
8. **AuthEpoch readiness (P2-N fix; promoted to invariant per audit 2026-04-26):** at cycle start, `authEpoch.ready === true` MUST hold; otherwise the cycle is skipped (no GraphQL fetched, no callback). `/inject-cookies` is the only path that toggles `ready` from `false → true`, and only after `page.url()` post-reload matches `/hosting` or `/hosting/messages`.
9. **Decoded-numeric equivalence in shadow mode (R2 subset clarification):** API-emitted message identity is `decode(api.id).slice("Message:".length)`. The shadow-mode promotion gate (`shadow → api`) requires, across ≥3 days of observation: (a) zero **decoded-numeric mismatches** within the `UI_msgIds ∩ API_msgIds` intersection (i.e. for each message both sides saw, the IDs decode to the same numeric); (b) zero `onlyInUi` events (i.e. UI never saw an ID the API didn't return — that would indicate the API is missing live data, NOT a virtualization quirk). `onlyInApi` events are tolerated because UI's DOM virtualizes (~15–20 visible) while the API returns 50 per thread per cycle. Implementation lives in the shadow comparator (§4 step 6 sync model), NOT the emit step.

---

## 3. External API Contract (Observed)

### Endpoint pattern

```
GET https://www.airbnb.com/api/v3/<OperationName>/<persistedQueryHash>
  ?operationName=<OperationName>
  &locale=en
  &currency=USD
  &variables=<urlencoded JSON>
  &extensions=<urlencoded JSON, contains persistedQuery hash again>
```

### Required headers (probe-confirmed 2026-04-26)

Bare `fetch()` from `page.evaluate` returns 400 + GraphQL error envelope. The Apollo-wrapper headers MUST be forwarded. Observed set:

| Header | Value semantics | Source |
|---|---|---|
| `x-airbnb-api-key` | `d306zoyjsyarp7ifhu67rjxn52tv0t20` (public web client key) | static, env-pinned |
| `x-airbnb-graphql-platform` | `web` | static |
| `x-airbnb-graphql-platform-client` | `minimalist-niobe` | static |
| `x-airbnb-supports-airlock-v2` | `true` | static |
| `x-niobe-short-circuited` | `true` | static |
| `x-csrf-token` | empty string (length 0) | static; Niobe sends empty |
| `x-csrf-without-token` | `1` (length 1) | static |
| `x-airbnb-client-trace-id` | random per-request | generated each call |
| `x-airbnb-network-log-link` | random per-request | generated each call |
| `x-client-request-id` | random per-request | generated each call |
| `x-client-version` | SPA build hash (e.g., `6d0b16e740d265e994b0e76bd84973729e341f1d`) | extract from current SPA bundle on session start |
| `content-type` | `application/json` | static |

**Per-request randoms (P2-G + P0-J + P0-T fix — bias-correction Codex/Gemini/Opus audit 2026-04-26):** sidecar generates fresh values each call. Format observed: regex `/^[a-z0-9]{28}$/` (base36). All 6 captured samples conform and contain non-hex chars (`u`, `g`, `n`, `t`, `w`, `z`): `0a8ufr10xfg8un0n527w40zttg0b`, `1g368rt1ds4d7x12urmrb0bgmdu2`, `0175q6x0a9mfne0zaqf8e14toxv9`, `1eqrwvk1msbs651l2fy8i0xs0xhx`, `1b4yi4s0k9f9gk0w2g5e00v2coc4`, `11wyv0a0mbrd3f1v7g44r16kbd7q`. Plain hex would be detectable as non-SPA (no chars in `g-z`).

**Bias profile of naive `b % 36`:** since 256 mod 36 = 4, four characters (indices 0–3 = `a`,`b`,`c`,`d`) are over-represented by **+12.5% relative** (or +0.39 percentage points absolute) versus the other 32. Spec v2 incorrectly claimed "~0.5%/char"; audit corrected. While probably below WAF detection thresholds today, chi-squared tests on N=10+ samples can distinguish from uniform. Use rejection sampling to eliminate the bias entirely:

```ts
import { randomBytes } from 'crypto';
const TRACE_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TRACE_ID_THRESHOLD = 252; // floor(256 / 36) * 36; bytes >= 252 are rejected.

function generateTraceId(): string {
  const out = new Array<string>(28);
  let i = 0;
  while (i < 28) {
    const buf = randomBytes(28 - i + 8); // small over-fetch to amortize rejection cost
    for (const b of buf) {
      if (b >= TRACE_ID_THRESHOLD) continue;
      out[i++] = TRACE_ID_CHARS[b % 36];
      if (i === 28) break;
    }
  }
  return out.join('');
}
```

Whether values encode anything (CRC, timestamp, monotonic counter) is unknown; treat as opaque random. If a future probe identifies semantic structure, revisit.

**SPA build hash extraction (P1-B + R2 mode-gating fix):** the only verified extraction path is via response listener. At session start, install `page.on('response', ...)`. On the first GraphQL request observed, capture the request URL's `x-client-version` header (via `request.headers()` accessor on the corresponding `Request` object). Pin this value for the session. **No `window.__APOLLO_INITIAL_STATE__` or `meta[name=webpack-chunk-version]` paths assumed** — those were speculation in v1; probe did not verify them. If the response listener has not yet captured one, the reader skips its first cycle (no harm; UI mode is still active). Refresh on `page.reload()` whenever Playwright already navigates the page (e.g. as part of `/inject-cookies`); the listener picks up the next organic GraphQL fetch. **A reload triggered SOLELY to capture this header is mode-gated identically to §4 step 2** — never in `ui` or `shadow` (would destroy parallel UI scraper context); permitted in `api` mode only.

Bare-browser-set headers (`user-agent`, `sec-ch-ua-*`, `sec-ch-viewport-width`, `accept-language`, `referer`) are inherited automatically by `page.evaluate(fetch)` — verified by read-mark test 2026-04-26.

### Operation A — `ViaductInboxData` (inbox listing)

- **Path:** `/api/v3/ViaductInboxData/<hash>`. Hash captured (pinned via env): `ebeb240346015c12be36d76fd7003cbef5658e1c6d2e60b3554280b3c081aeea`.
- **Variables (full set, per probe):**
  - `userId`: `Vmlld2VyOjUwNzU4MjY0` (= `base64("Viewer:50758264")`) — env-pinned
  - `numRequestedThreads`: 15
  - `numPriorityThreads`: 2
  - `getPriorityInbox`: true
  - `useUserThreadTag`: true
  - `originType`: `"USER_INBOX"`
  - `threadVisibility`: `"UNARCHIVED"` (also `"ARCHIVED"`, `"REQUEST"` — out of scope v0)
  - `threadTagFilters`: null
  - `query`: null
  - `getLastReads`: **false** (pinned — see §3 Read-mark policy)
  - `getThreadState`, `getParticipants`, `getInboxFields`, `getMessageFields`: **true**
  - `getInboxOnlyFields`, `getThreadOnlyFields`: **false**
  - `skipOldMessagePreviewFields`: false
- **Response paths:**
  - `data.node.messagingInbox.inboxItems.edges[].node.id` → `GlobalThreadId` per thread (extract directly)
  - `data.node.messagingInbox.inboxItems.edges[].node.participants.edges[].node.accountId` → host-membership check
  - `data.node.messagingInbox.inboxItems.edges[].node.mostRecentInboxActivityAtMsFromROS`, `inboxVisibility`, `inboxItemHighlight`
  - `data.node.messagingInbox.inboxItems.pageInfo.{startCursor, endCursor, hasNextPage, hasPreviousPage}` — Relay pagination

### Operation B — `ViaductGetThreadAndDataQuery` (single thread + messages)

- **Path:** `/api/v3/ViaductGetThreadAndDataQuery/<hash>`. Hash captured: `9384287931cf3da66dd1fae72eb9d28e588de4066e05d34a657e30a9e9d2e9ef`.
- **Variables (full set):**
  - `globalThreadId` — string from inbox response
  - `numRequestedMessages`: 50
  - `originType`: `"USER_INBOX"`
  - `getThreadState`, `getParticipants`, `getInboxFields`, `getMessageFields`: true
  - `getInboxOnlyFields`, `getThreadOnlyFields`: false
  - `skipOldMessagePreviewFields`: false
  - `getLastReads`: **false** (pinned, see Read-mark policy)
  - `forceReturnAllReadReceipts`: **false** (pinned)
  - `forceUgcTranslation`: **false** (pinned — auto-translation destroys NLP signal)
  - `isNovaLite`: false
  - `mockThreadIdentifier`, `mockMessageTestIdentifier`, `mockListFooterSlot`: null
- **Response paths:**
  - `data.threadData.id` — must decode to expected raw thread ID
  - `data.threadData.messageData.messages[]` — message list
  - `data.threadData.messageData.{hasOlder, hasNewer, upToDate}` — pagination flags
  - `data.threadData.messageData.expandedCursorsSegment.{earliestCursor, latestCursor}` — cursors
  - `data.threadData.participants.edges[].node.accountId` — host-membership check
  - `data.threadData.orderedParticipants[]` — `{accountId, accountType}` simpler list

### Read-mark policy

Probe 2026-04-26 confirmed both `getLastReads=true` AND `getLastReads=false` return populated `messageData.messages[]` (15 and 7 messages respectively for two threads). Pin to `false` defensively; canary monitors host response-time score for first 7 days post-promote.

**Sandbox read-mark verification — VERIFIED 2026-04-26 21:31 UTC.** Method: host marked one inbox thread unread on the Airbnb mobile app (iPhone). Sidecar fired a single `ViaductGetThreadAndDataQuery` against that thread's `globalThreadId` with `getLastReads=false, forceReturnAllReadReceipts=false, forceUgcTranslation=false` (status 200, ~30 messages returned, identity invariants OK). 30 seconds later, the mobile app **still showed the thread as unread**. **Conclusion: this flag combination does NOT mark threads as read on the host's primary device.** Pre-merge gate 2 satisfied. Per-thread identifiers and guest names from this trial are intentionally omitted; see git history if reproduction details are needed (and rotate before sharing externally).

Caveats:
- Single-trial test on one device (iOS); not exhaustive across iOS/Android/web/host-clients.
- `inboxItemHighlight=null` on this thread BOTH pre- and post-fire — confirming `inboxItemHighlight` does NOT track per-host unread state (it tracks priority/highlight signals like POSITIVE for active reservations). Real "unread" state lives in `messageData.lastReads[]` (gated by `getLastReads`) — which we deliberately do not request.
- Canary still monitors response-time score post-promote in case Airbnb changes server-side semantics.

### `hydratedContent` extractors (probe-confirmed shapes)

| `contentType` | `contentSubType` | `account.accountType` | Body extraction |
|---|---|---|---|
| `TEXT_CONTENT` | (none) | `USER` | `content.body` (also `content.bodyTranslated` if present) |
| `MEDIA_CONTENT` | (none) | `USER` | `content.mediaItems[].uri` (URLs only — no caption present in samples) |
| `VIEWER_BASED_CONTENT` | `STAYS_INSTANT_BOOKED` (and likely siblings) | `SERVICE` | `content.body` + `content.linkText`. Classify as system message — do NOT route to AI reply path |
| `TEMPLATE_CONTENT` | e.g. `STAY_ALTERATION_WITHOUT_LISTING_CHANGE_PENDING` | `USER` | `content.headerV2.tombstoneHeader.title.body` + `kicker.body` for primary text. May have `actionPanel`, `dismissScenarios` sub-fields. |
| `STATIC_BULLETIN_CONTENT` (P1-L fix — observed 2026-04-26 live probe) | (varies) | (typically `SERVICE` — confirm per occurrence) | Classify as system message — do NOT route to AI reply path. Probe v4 needed to characterize body shape; v0 emits placeholder `[bulletin:contentSubType:<subtype>]` until shape captured, with diagnostic counter. |
| **unknown** | * | * | Emit row with `text="[unsupported:contentType:" + contentType + "]"`. Log diagnostic. |

**Alteration requests** (key business case) live as `TEMPLATE_CONTENT` messages **inside a regular `MessageThread`**, NOT as a separate `AlterationThread` Relay node-type. Probe confirmed.

### Persisted-query env

- `AIRBNB_API_INBOX_HASH` (pinned)
- `AIRBNB_API_THREAD_HASH` (pinned)
- `AIRBNB_API_USER_ID` (numeric, e.g. `50758264`)
- `AIRBNB_API_GLOBAL_USER_ID` (precomputed `base64("Viewer:" + numericId)`)
- `AIRBNB_API_KEY` (web client key, e.g. `d306zoyjsyarp7ifhu67rjxn52tv0t20`)
- `AIRBNB_API_CLIENT_VERSION` (SPA build hash; extracted at runtime)

---

## 4. Implementation Strategy

### Module: `src/playwright/api-reader.ts` (new)

```ts
export async function readInboxViaApi(
  page: Page,
  opts: ReadInboxOptions
): Promise<ScrapedMessage[]>
```

### Cycle flow

1. **Pre-cycle.** First check `authEpoch.ready === true` (P2-N fix); if false, skip cycle, log diagnostic, return empty `ScrapedMessage[]`. Then record `cycleId = uuid()`, `cycleStartAuthEpoch = currentAuthEpoch()`.
2. **SPA hash + build-version state (P1-A + P1-B + P0-Q fix — Codex/Gemini audit 2026-04-26).** A continuous response listener (installed at session start, never per-cycle) maintains:
   - `lastObservedInboxHash` (from any SPA-issued `ViaductInboxData` path)
   - `lastObservedThreadHash` (from any SPA-issued `ViaductGetThreadAndDataQuery` path)
   - `lastObservedClientVersion` (from any SPA-issued GraphQL request's `x-client-version` header)

   Values come from the **SPA's own organic traffic** (the user's natural Chromium tab usage on Fly's headless page; SPA fires these on page-load + `mostRecentInboxActivityAtMsFromROS` polling + websocket events). If the listener has not captured a value within `SPA_OBSERVATION_GRACE_MS=300_000` (5 min):
   - **In `ui` or `shadow` mode** — the API reader simply **skips the cycle** (logs `apiSkipReason="no_spa_observation"`, returns empty diagnostic batch). It MUST NOT force `page.reload()` because the UI scraper is the sole callback emitter and a reload would tear down the UI scraper's execution context, causing it to fail or return partial data. The reader keeps the listener installed and waits for the next cycle. UI scraper continues unaffected.
   - **In `api` mode** — the API reader is the sole emitter; here it MAY force a `page.reload({ waitUntil: 'networkidle' })` because the destruction it causes is to its own context, not a parallel UI scraper's. After reload, wait up to 30 s for SPA to fire fresh GraphQL, capture, then retry the cycle.

   Cycle uses `lastObservedInboxHash || AIRBNB_API_INBOX_HASH` (env-pinned fallback).
3. **List inbox** — call `ViaductInboxData` with full variable set (above) via `page.evaluate(fetch, headers + url)`.
   - Validate schema fingerprint: required paths `data.node.messagingInbox.inboxItems.edges`, `pageInfo`, `edges[].node.id`, `edges[].node.participants.edges[].node.accountId`. Empty `edges[]` is legitimate (new host) — fingerprint check passes if the path EXISTS, regardless of length (P2-H clarification).
   - Validate host-membership: at least one thread's participants must include `AIRBNB_API_USER_ID`. If zero threads AND `edges.length === 0` (legitimate new host with no conversations) → log diagnostic + emit empty batch (no abort). If zero threads AND `edges.length > 0` (cookies for wrong account) → abort cycle, `cookie_valid=false`.
   - Decode each `node.id` prefix; reject anything not in `ALLOWED_THREAD_PREFIXES` with loud alert.
4. **Per thread (sequential, 500–1500 ms randomized jitter between each):**
   - **AuthEpoch check** — if changed since cycle start, abort.
   - Call `ViaductGetThreadAndDataQuery` with extracted `globalThreadId`.
   - **Identity invariant** — `decode(response.data.threadData.id) === decode(globalThreadId)`. Else drop thread.
   - **Host-membership invariant** — `data.threadData.participants.edges[].node.accountId` must include `AIRBNB_API_USER_ID`.
   - **Schema fingerprint (P2-H clarification)** — required PATHS exist on the response root:
     - `data.threadData.messageData.messages` (must be an array; may be length 0 for empty thread — that's not a fingerprint failure)
     - `data.threadData.messageData.expandedCursorsSegment` (object)
     - `data.threadData.id` (string)
     - `data.threadData.participants.edges` (array)
     - For each `messages[i]` (when array is non-empty): `id`, `account.accountId`, `createdAtMs` must be present.
     - Empty `messages[]` is OK; missing the `messages` array entirely is a fingerprint failure → drop thread + alert.
   - **Cursor walk** — if `messages.length === 50 && hasOlder === true && oldest_in_page.createdAtMs > watermark[rawId]`, walk `earliestCursor` until either: (a) message older than watermark observed (overlap), (b) `hasOlder === false`, or (c) cap of 5 cursor-walks per cycle.
   - For each message: validate origin (`account.accountId` ∈ thread participant accountIds); apply `extractText(hydratedContent, contentType)`; assemble `ScrapedMessage`.
5. **Sort + emit** — flatten across threads; **per-thread sort by `createdAtMs ASC`** before emitting batch to callback.
6. **Post-cycle (P0-R fix + R2 livelock/exec-model fix — Codex/Gemini/Sonnet audit 2026-04-26).**
   - **In `api` mode** — after callback returns 2xx, update watermark per thread = max(`createdAtMs`) of emitted messages.
   - **In `shadow` mode** — there is no API-side callback. The shadow comparator uses **subset (`UI_msgIds ⊆ API_msgIds`)**, not equality. Rationale (Gemini R2): UI scraper's DOM may render fewer messages per scroll (~15–20) than the API returns per call (50). Equality would create a permanent `onlyInApi` discrepancy and the watermark would never advance, livelocking the cursor-walk validation.
     - **Execution model:** the comparator runs **synchronously within step 6** in shadow mode. Concretely: API reader's step 6 calls `awaitUiBatchForCycle(cycleId, timeoutMs=10000)` — the shared per-cycle queue from the UI scraper. If the UI batch arrives in time and `UI_msgIds ⊆ API_msgIds` and zero `onlyInUi` (i.e., UI saw nothing the API didn't), advance watermark per thread = max(`createdAtMs`) of API messages whose `id` is also in UI batch — i.e. only advance watermark over the intersection (Sonnet R2 vacuous-match defense). If timeout, log and skip watermark advance (no progress that cycle is fine; cursor-walk will retry).
     - **AuthEpoch defense within comparison window (Sonnet R2):** if `currentAuthEpoch() !== cycleStartAuthEpoch` at the moment of comparison, abort comparison + watermark advance for this cycle.
   - **In `ui` mode** — API reader is dead code; no watermark file written.
   - **Persistence** — atomic write within the same directory as the target file (write `<dir>/watermarks.json.tmp` then `rename(2)`). Cross-mount renames return `EXDEV` if a Fly volume is mounted at `data/` while temp lives under `/tmp/`; tmp file MUST be in the SAME directory as the target file.

### Why `page.evaluate(fetch)` with forwarded headers

- Avoids cookie extraction → no change to `src/lib/env.ts`, no new credential surface.
- Matches SPA TLS fingerprint, sec-ch-ua, user-agent automatically.
- Mandatory: forward 12 Apollo-wrapper headers (8 static, 3 per-request randoms, 1 SPA build hash). Bare fetch fails 400.

### Failure modes

| Trigger | Action |
|---|---|
| GraphQL `errors[]` with auth/challenge codes; HTTP 401/403; HTML body; PX/Datadome JSON | `cookie_valid=false`, abort cycle, no callback |
| `PERSISTED_QUERY_NOT_FOUND` (P1-A + P0-S + R2-Gemini "ui mode is dead code" fix). Triggered only when API reader executes — i.e. in `shadow` or `api` mode (in `ui` mode the reader does not run, so no error to handle). Detection: HTTP 404 OR HTTP 200 with `errors[].extensions.code === "PERSISTED_QUERY_NOT_FOUND"` OR HTTP 200 with `errors[].message` containing `"PersistedQueryNotFound"`. Apollo / Niobe servers commonly return 200 + GraphQL-error envelope rather than 404. | Step 1: check `lastObservedInboxHash`/`lastObservedThreadHash`. If different from currently-used hash → use observed hash, retry the failed call once. Step 2: if still failing — `page.reload()` is gated by `INBOX_READER_MODE` (see step 2 of cycle flow): in `shadow` mode, abort cycle (UI mode still unaffected) and surface alert; in `api` mode, force reload, wait up to 30 s for fresh SPA GraphQL, capture new hash, retry. Step 3: if still failing → alert via `airbnb-system:hash-rotation-stuck` channel (push path; v0 surfaces via `/health` JSON only, see §5) + abort cycle. **In `api` mode, never substitute a UI scrape for the failed API call within this cycle** — wait for next cycle. |
| Identity mismatch — thread-id mismatch (`decode(response.threadData.id) !== decode(requested globalThreadId)`) | Drop the single offending thread, log diagnostic, continue cycle with remaining threads. |
| Host-membership mismatch — single thread (`AIRBNB_API_USER_ID` not in that thread's `participants.edges[].node.accountId`) | Drop the single offending thread, log diagnostic, continue cycle with remaining threads. (Could happen if Airbnb returns a thread that's been re-assigned, demoted, or contains a stale handoff record. Per-thread = recoverable.) |
| Host-membership mismatch — **all** inbox threads in the cycle (no thread's `participants.edges[].node.accountId` includes `AIRBNB_API_USER_ID` AND `inboxItems.edges.length > 0`) | Cookies are for the wrong host. Set `cookie_valid=false`, abort cycle, no callback. (Edge: brand-new host with `inboxItems.edges.length === 0` passes; documented as known limitation.) |
| Schema fingerprint missing required path | Drop that thread (or abort cycle if missing in inbox response), alert |
| `Execution context was destroyed` (page navigated/torn down) (P2-E fix) | Skip current cycle. Log diagnostic. Retry on next scheduled cycle. **Do NOT cascade `cookie_valid=false`** — context destruction is normally a routine reload, not an auth failure. Only flag `cookie_valid=false` if reload-and-retry then sees a `/login` URL or auth-shaped GraphQL error. |
| Network timeout | Retry once with 2 s backoff; second failure → skip thread, continue cycle |
| `messages.length === 0` | Emit zero rows (legitimate empty thread) |
| AuthEpoch changed mid-cycle | Abort emission, do not call callback |
| `/inject-cookies` reload lands on `/login` (P2-F fix) | After `page.reload()` post-cookie-inject, assert `page.url()` matches `/hosting/messages` (or `/hosting`). If `/login` → cookies are invalid → set `cookie_valid=false`, do not flip `authEpoch.ready` to true, surface alert. |

### Concurrency & pacing

- Per-thread fetches: **sequential** (concurrency 1).
- Inter-thread jitter: 500–1500 ms randomized.
- Cycle-level jitter: ±20% of nominal cycle interval.
- **Optional** burst-shaping: dispatch a synthetic `MouseEvent` on the corresponding `inbox_list_<rawId>` row before each fetch (restores SPA-like interaction-to-fetch timing correlation; blocks observable for PerimeterX behavioral profiling).

### Feature flag — `INBOX_READER_MODE`

| Value | Behavior |
|---|---|
| `ui` (default) | Existing UI scraper. Sole callback emitter. |
| `shadow` | API reader runs alongside UI. API emissions go to **diagnostic side channel** (sidecar log + structured comparison data); **callback only receives UI emissions**. **Decoded-numeric equivalence** (per §1 Definition of Done) logged per message: extract numeric from API id (`base64Decode(api.id).slice("Message:".length)`) and compare to UI's `data-item-id`. |
| `api` | API reader is sole callback emitter. UI scraper disabled. Promote ONLY after `shadow` mode shows ≥3 days of 0 numeric-equivalence mismatches across all live threads. |

`dual` mode from v0 is **deleted** — replaced by `shadow` to eliminate dual-context state corruption (API mark-as-read polluting UI's view).

### Cookie injection contract change

`/inject-cookies` endpoint: **bumps `authEpoch` first**, then writes cookies via `browserContext.clearCookies()` + `addCookies()`, then forces `page.reload({ waitUntil: 'networkidle' })`. Until reload completes, `authEpoch.ready === false`. After reload, **assert `page.url()` matches `/hosting` or `/hosting/messages`** (P2-F fix); if `/login` → set `cookie_valid=false`, leave `authEpoch.ready=false`, surface alert. `readInboxViaApi` skips cycle if `!authEpoch.ready`.

---

## 5. Diagnostics

`__lastInboxDiag` extended:

```ts
{
  cycleId: "uuid",                     // cross-cycle correlation
  cycleStartAuthEpoch: 17,
  cycleEndAuthEpoch: 17,
  authEpochAborted: false,
  mode: "ui" | "shadow" | "api",
  api: {
    inboxHash: "ebeb240346015c12...",
    inboxHashFromSpa: "ebeb240346015c12...",   // observed hash this cycle
    threadHash: "9384287931cf3da6...",
    schemaFingerprintOk: true,
    threadsRequested: 15,
    threadsReturned: 15,
    threadsDroppedHostMembership: 0,
    threadsDroppedIdentityMismatch: 0,
    threadsDroppedUnknownPrefix: 0,
    perThread: [{
      rawId: "2476957479",
      globalThreadId: "TWVzc2FnZVRocmVhZDoyNDc2OTU3NDc5",
      decodedPrefix: "MessageThread",
      identityCheck: "ok" | "mismatch" | "skip",
      hostMembership: "ok" | "missing",
      messagesReturned: 14,
      hasOlder: false,
      cursorWalksPerformed: 0,
      contentTypeCounts: { TEXT_CONTENT: 12, MEDIA_CONTENT: 1, TEMPLATE_CONTENT: 1 }
    }],
    totalMessagesEmitted: 27,
    elapsedMs: 4231
  },
  shadow: {
    uiToApiIdMatches: 27,
    uiToApiIdMismatches: 0,
    onlyInUi: [],
    onlyInApi: [],
    // Captured for future per-listing routing spec (P1-D). v0 does not route by listing.
    perThreadListingHints: [{
      rawId: "2476957479",
      inboxListingImageUrl: "https://...",      // value (URL only, no PII)
      confirmationCodeFromHostingDetails: null  // captured if StayHostingDetailsQuery fires this cycle
    }]
  },
  fallbacks: { hashAutoRecoveryFired: false, ... },
  lastHashOkAt: "2026-04-26T18:15:00Z",
  alerts: []
}
```

### Hash-rotation alert routing (P1-C fix — mode-agnostic)

The alert channel must work in **all** modes (`ui`, `shadow`, `api`). Two parallel paths:

1. **Pull path (mode-agnostic):** sidecar `/health` endpoint returns JSON including `lastHashOkAt`, `lastObservedInboxHash`, `lastObservedThreadHash`, `lastObservedClientVersion`, `hashAutoRecoveryFiredAt`, `hashRotationStuck`. The existing `/health-check` skill (per Paul's CLAUDE.md, run on demand or via cron) polls this and surfaces drift. This is the primary signal in `api` mode where shadow side channel is unavailable.

2. **Push path (mode-agnostic, observability):** sidecar emits a structured event to a `POST /api/airbnb-system-events` (or similar host-side telemetry endpoint) — **NOT** the existing `/api/playwright-callback` (contract is sacred). Schema:
   ```json
   { "host_id": "<UUID>", "event": "hash-rotation-stuck", "ts": "<ISO>", "details": { ... } }
   ```
   This new endpoint is implemented in StaySync as a separate addition to support sidecar telemetry across modes. **Calling this endpoint is OUT OF SCOPE for v0** — sidecar logs to its own log file and `/health` JSON; if Paul wants Slack/email push later, the StaySync-side endpoint can be added without changing the sidecar. Until then, `/health-check` cron is the only path.

**Decision for v0:** ship pull-path only. Push-path is documented but deferred. `/health-check` cron schedule (per Paul's setup) determines surface latency. If hash rotation stuck for >24h with no alert routed, Paul learns when `/health-check` next runs.

---

## 6. Out of Scope (v0; explicit gates)

- `threadVisibility=ARCHIVED` and `=REQUEST` inboxes — v1.
- `SyncProtocolSubscription` real-time channel — v2.
- Reactive `parentMessageId` ordering reconciliation — v1. v0 drops reaction rows whose parent isn't in the same emission batch.
- Soft-delete tombstone (un-delete races) — v1.
- Multi-host operation — explicitly closed: v0 enforces single-host via `AIRBNB_API_USER_ID` invariant; multi-tenant is a separate program.
- Translation parity with the UI (`forceUgcTranslation: false` always).

### Newly-added considerations (debate-surfaced)

- **Timezone drift:** sidecar must trust server-returned `createdAtMs`. Local clock not used for ordering. Watermark file logs both server timestamp and observed-local-receive timestamp for diagnostic.
- **New listing on host account:** if a thread's listing is unknown to sidecar's prior state, accept first sighting. Do NOT walk `earliestCursor` on first-sighting; cap at 50 messages and let cursor-walk pick up older history on subsequent cycles after watermark established.
- **Locale mismatch:** spec sends `locale=en&currency=USD`. If host profile is non-en, response may include translated content despite our hint. Probe v3 (followup) should sample a thread under different locale to characterize.
- **Per-listing routing (P1-D resolution):** StaySync callback currently attaches conversations to host's first active property (`resolveFallbackPropertyId`). Same behavior as today's UI sidecar. The API path captures `inboxListingImageUrl` per thread (and `confirmationCode` via `StayHostingDetailsQuery` — observed in probe but unused) which COULD support per-listing routing if the callback contract were extended. Hard rule prohibits callback-contract changes here. **v0 captures listing-discriminating data into shadow-mode diagnostics for future use** but does NOT route by listing.

---

## 7. Test Strategy

### Pre-merge gates

1. **Probe v3 captures committed (sanitized).** Already produced and stored at `/tmp/airbnb-network-probe.json` and `/tmp/airbnb-readmark-test.json` during 2026-04-26 session. Sanitize and commit to `tests/fixtures/api-reader/`.
2. **Sandbox read-mark verification.** Out-of-band test: leave thread unread on second device, run sidecar v0.2 with `getLastReads=false`, verify second device still shows unread. Document outcome.
3. **Real fixtures committed.** Three sanitized response JSONs:
   - `inbox-15-threads-mixed.json` — 15-thread inbox with 2-participant + 3-participant variants. **Committed 2026-04-26.**
   - `thread-with-mixed-content.json` — single thread with `TEXT_CONTENT`, `VIEWER_BASED_CONTENT`, and `TEMPLATE_CONTENT` (alteration pending + accepted). **Committed 2026-04-26.**
   - `thread-with-media-content.json` — single thread with `TEXT_CONTENT`, `VIEWER_BASED_CONTENT`, and `MEDIA_CONTENT`. **Committed 2026-04-26.**
   - **Gaps (deferred):** no fixture currently covers `STATIC_BULLETIN_CONTENT` (5th type observed but in a different thread; placeholder branch tests cover it for v0), no soft-deleted message (`isSoftDelete: true`), no isolated reaction-only row. v0 unit tests cover these branches via synthetic mutations on the committed fixtures (e.g., set `isSoftDelete: true` in a copy and assert drop). When probe v4 captures real instances, add dedicated fixtures.

### Unit (`tests/api-reader-mapping.test.ts`)

- `globalThreadIdFor("2476957479") === "TWVzc2FnZVRocmVhZDoyNDc2OTU3NDc5"` (consistency check; not used in primary path)
- `rawIdFromGlobal("TWVzc2FnZVRocmVhZDoyNDc2OTU3NDc5") === "2476957479"`
- Identity invariant — fixture with mismatched IDs rejected
- Host-membership invariant — fixture without env-pinned accountId rejected
- Soft-delete is dropped
- Reaction without parent in batch is dropped (v0)
- `extractText` per contentType: TEXT, MEDIA, VIEWER_BASED (system class), TEMPLATE; unknown emits placeholder
- Sort `createdAtMs ASC` is enforced
- Cursor-walk overlap requirement (gap-fill with watermark)
- Schema fingerprint: missing required path triggers drop

### Integration (`tests/api-reader-flow.test.ts`)

- Stub `page.evaluate(fetch)` returns canned responses from fixtures
- Assert: 2-thread inbox → 2 thread fetches → mapped messages count matches fixture
- Assert: shadow mode emits diagnostic-only, no callback
- Assert: AuthEpoch change mid-cycle aborts emission
- Assert: hash auto-recovery triggers when SPA hash differs

### Live canary (manual, gated)

1. **Local sandbox sync** with `INBOX_READER_MODE=shadow` and Sandbox Airbnb account if available.
2. **Build candidate Fly image** with shadow mode.
3. **Deploy + watch ≥1 hour.** Required: 0 ID-mismatches across all observed threads, schemaFingerprintOk = true every cycle, no auth-epoch aborts.
4. **Continue shadow ≥3 days.** Required: cumulative 0 ID-mismatches across all live threads. Document hash observations.
5. **Sandbox read-mark verification.** As above.
6. **Promote** by env flip to `INBOX_READER_MODE=api`. Watch DB counts and host response-time score for 7 days.
7. **Rollback path:** env flip back to `ui`. Always available.

---

## 8. ADRs

### ADR-001: Persisted GraphQL over UI scrape (CONFIRMED)
- **Decision:** call internal persisted-query GraphQL endpoints discovered via sanitized CDP probe.
- **Rationale:** stable hashes (verified across 4 probe runs), Relay cursor pagination, identity-checkable response, allow-listed Relay node-type prefix, structured `hydratedContent` per contentType.
- **Consequence:** new failure mode (hash rotation) requires SPA-XHR auto-recovery + alert. New failure mode (header forwarding) requires Apollo-wrapper header capture. Both implemented.

### ADR-002: `page.evaluate(fetch)` with forwarded Apollo headers
- **Decision:** issue `fetch()` from inside Playwright page context, forwarding 12 Apollo-wrapper headers (8 static + 3 per-request randoms + 1 SPA build hash).
- **Rationale:** no cookie extraction, no `env.ts` change, matches SPA TLS fingerprint, single auth source. Probe confirmed bare fetch returns 400.
- **Consequence:** depends on a healthy logged-in `page`. Requires retry on `Execution context destroyed`. Per-request random header generators must match observed format.

### ADR-003: Feature flag `INBOX_READER_MODE` with `shadow` (NOT `dual`)
- **Decision:** ship `ui` (default), `shadow` (run-both, API to side channel only), `api` (cutover).
- **Rationale:** `dual` mode (v0) was rejected by debate — API call mark-as-read polluting UI's view, dual-context state corruption. `shadow` keeps UI as sole callback emitter while API observes in parallel; comparison is offline.
- **Consequence:** more wiring (separate diagnostic emission path); promotion gate requires ≥3 days 0 mismatches on **decoded-numeric equivalence** (P0-K fix; raw byte equivalence is impossible because UI emits 11-char numeric and API emits 28-char base64-encoded `Message:<numericId>`).

### ADR-004: Extract `globalThreadId` from inbox response, never construct
- **Decision:** spec §2 `GlobalThreadId` is always `inboxItems.edges[].node.id`; allow-list known prefixes.
- **Rationale:** debate (Gemini P0) — Relay schema may emit other node types beyond `MessageThread:`; constructing from raw ID would silently drop unknown types every cycle.
- **Consequence:** v0 is robust against future thread-type additions; loud alert if unknown prefix appears.

### ADR-005: Pin read-receipt flags to `false`
- **Decision:** `getLastReads: false` and `forceReturnAllReadReceipts: false` and `forceUgcTranslation: false` in all thread fetches.
- **Rationale:** probe confirmed both flag variants return populated `messageData.messages[]`; we lose nothing. Defensive against potential read-mark side effect on host response-time metric.
- **Consequence:** if Airbnb later adds fields gated by these flags, response shape may shift. Schema fingerprint catches.

### ADR-006: Host-membership invariant replaces `viewer` query
- **Decision:** validate identity via `participants.edges[].node.accountId` containing `AIRBNB_API_USER_ID`, NOT via a separate viewer-identity GraphQL call.
- **Rationale:** probe confirmed neither keystone op returns `viewer`/`currentUser`. Adding a new query expands behavioral surface for WAF profiling. Host-membership check is implicit in data we already fetch.
- **Consequence (R3 audit 2026-04-26 — corrected per §2 invariant 1c):** Two-tier behavior: (a) per-thread host-membership miss drops the single thread and continues (recoverable, e.g. re-assigned thread). (b) Cycle-wide miss across all `inboxItems.edges` (when `edges.length > 0`) means cookies are wrong-host → fail closed. (c) Brand-new host with `inboxItems.edges.length === 0` (legitimate empty inbox) PASSES the host-membership check vacuously — there are no participants to validate against. The known limitation: a brand-new host whose cookies are silently wrong cannot be distinguished from a brand-new host with valid cookies until the first conversation appears. This is acceptable for v0 (single-host operation; cookies are the same Paul-injected pair always). Multi-host operation, where this matters, is explicitly out of scope (§6).

### ADR-007: AuthEpoch lock between `/inject-cookies` and read cycle
- **Decision:** introduce monotonic counter; cycle aborts if counter changes mid-flight.
- **Rationale:** debate Q2(b) — without a lock, mid-cycle cookie rotation can split a 7-22 second sequential read across two sessions, producing wrong-host data with no detection.
- **Consequence:** `/inject-cookies` becomes a slightly heavier handshake (clear + add + reload + bump epoch + ready flag). Reader skips cycle if `!authEpoch.ready`.

---

## 9. Open Questions Resolved

- **Q1 (`hydratedContent` shape):** RESOLVED. 4 contentTypes captured + extractor per type defined. Unknown → placeholder.
- **Q2 (thread cap 15):** RESOLVED. v0 caps at 15 + cursor-walk for older messages on watermark gap. Inbox pagination via `pageInfo.endCursor` deferred to v1 only when host has >15 active threads (not currently the case).
- **Q3 (hash rotation alerting):** RESOLVED. Diagnostic side channel + `/health` endpoint pollable by `/health-check`. Auto-recovery via SPA-XHR observation.
- **Q4 (cursor-walk in v0):** RESOLVED. Yes, with watermark protocol.
- **Q5 (multi-host):** CLOSED. v0 single-host only; multi-host is a separate program.

---

## 10. Implementation Order (deferred to /to-issues after spec lock)

1. **v0.1** — `api-reader.ts` skeleton + `ViaductInboxData` only + sanitized fixtures + unit tests for ID extraction, host-membership, schema fingerprint. Run in production as `INBOX_READER_MODE=ui` so this is dead code; just typecheck + tests.
2. **v0.2** — `ViaductGetThreadAndDataQuery` per thread + identity gates + `extractText` for 4 contentTypes + cursor walk + sort. Still mode `ui`.
3. **v0.3** — Wire `INBOX_READER_MODE=shadow` — diagnostic emission path. Deploy candidate Fly image. Begin ≥3-day shadow observation.
4. **v0.4** — After shadow gates pass: env flip to `api`. UI mode stays available as rollback path.

Each phase is a separate git commit + Fly image. Tests added per phase, not deferred.

---

## 11. Hard rules (carried forward verbatim)

- Never log cookies, headers (raw values), bodies, or message text.
- Fail closed on weak thread identity OR weak host membership OR weak cookie validity.
- Do NOT change `src/lib/env.ts`.
- Do NOT change StaySync `/api/playwright-callback` route or its dedup contract.
- Preserve `__lastInboxDiag` diagnostic.
- Production stays on the rolled-back image until shadow gates pass; rollback is env flip.
