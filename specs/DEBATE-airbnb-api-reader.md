# Debate: SPEC-airbnb-api-reader

**Date:** 2026-04-26
**Rounds:** 2 (early termination — Q2 converged; Q1 and Q3 disagreements crystallized)
**Models:** Claude Opus 4.7 (Architect / Reviewer A), Gemini 3.1 Pro Preview (Reviewer B), Codex GPT-5.5 (Reviewer C). Sonnet excluded per recent user direction.
**Spec under review:** `specs/SPEC-airbnb-api-reader.md` (repo-relative)

---

## Summary

### Confirmed issues / consensus (all three agreed; high confidence)

| # | Issue | Severity | Required fix |
|---|---|---|---|
| C-1 | **`globalThreadId` should be extracted from `ViaductInboxData` response, not constructed from `base64("MessageThread:" + rawId)`.** Other Relay node types (`SupportThread`, `AlterationThread`, `RequestThread`, `GroupThread`) will fail silently. | P0 | Spec §2: remove construction as primary identity. §4 step 2: use `inboxItems.edges[].node.id`. Add allow-list of known node-type prefixes; unknown → loud alert via callback diagnostic, not silent drop. |
| C-2 | **Cutover dedup risk: UI `data-item-id` may not equal API `msg.id`.** Without byte-equivalence proof, flip = re-emit historical messages. | P0 | Promotion gate: shadow mode for ≥3 days with 0 ID mismatches across all live threads. Spec §1 DoD must include explicit ID-equivalence assertion. |
| C-3 | **Hash-rotation fallback paradox.** Spec falls back to UI mode on `PERSISTED_QUERY_NOT_FOUND`, but UI mode is broken (the reason for this spec). Need real auto-recovery: re-load SPA, intercept fresh hash, reuse. | P0 | Spec §4 failure-mode table: replace "fall back to UI" with "auto-recover hash from SPA's own outbound XHR". v0 alternative: alert + page rotation, never silent UI fallback. |
| C-4 | **Stateful read-mark side effect.** `ViaductGetThreadAndDataQuery` with `getLastReads`/`forceReturnAllReadReceipts` likely marks threads read on Airbnb's side, harming host response-time metric. | P1 | Sandbox test before any production deploy. Pin flags to read-only variant (`getLastReads: false`, `forceReturnAllReadReceipts: false`). Document explicit sign-off if unavoidable. |
| C-5 | **`page.evaluate(fetch)` missing required SPA-injected headers.** `X-Airbnb-API-Key`, `X-CSRF-Token`, `X-Niobe-Short-Circuited`, sec-ch-ua, etc. Bare fetch will be flagged. | P1 | Probe v3: capture every non-cookie header observed in a SPA-issued request. Spec §3.x: enumerate required headers. Test with/without each. |
| C-6 | **PerimeterX/Datadome challenge often returns HTTP 200 with PX/DD JSON body, not 4xx.** Spec invariant 2 misses this. | P1 | Add JSON-body schema heuristics for `px_challenge`, Datadome interstitial, GraphQL `errors[]` with auth/challenge codes. Trip `cookie_valid=false` on detection. |
| C-7 | **Ordering must be enforced before callback emission.** API may return messages `createdAtMs DESC`; callback assumes UI-mode ordering. | P1 | Spec §4 step C: sort `createdAtMs ASC` per thread before emission. |
| C-8 | **Cursor gap-fill must overlap ≥1 known ID.** Otherwise messages can land in seams between cycles. | P1 | Spec §4: cursor walk emits a "seen anchor" message even when duplicate; abort older-page emission for a thread if no overlap. |
| C-9 | **Hash-rotation alert must be human-actionable**, not buried in `__lastInboxDiag`. | P1 | Route via callback diagnostic message type OR `/health` endpoint pollable by `/health-check`. Add `lastHashOk` timestamp + `schemaFingerprintOk` flag. |
| C-10 | **Real test fixtures required**, not "generated from probe". Probe captured key names, not values. | P1 | Probe v3 captures 2 sanitized response fixtures (inbox + thread w/ soft-delete + reaction + `hasOlder`). Commit to `tests/fixtures/api-reader/`. |
| C-11 | **Concurrency = WAF burn.** 15 parallel `fetch()` calls don't match SPA behavior. | P1 | Spec §4: sequential per-thread, 500–1500 ms randomized jitter. Cycle-level jitter ±20%. |
| C-12 | **`page.evaluate(fetch)` context-loss handling.** SPA self-refreshes → `Execution context was destroyed`. | P1 | Wrap calls in retry loop catching context-destroyed errors. On second failure, treat as cookie-invalid. |
| C-13 | **`/inject-cookies` race: authEpoch lock.** Mid-cycle cookie rotation can split session within one cycle. | P1 | Add `authEpoch` monotonic counter. `readInboxViaApi` records epoch pre-list, aborts pre-emit if changed. |
| C-14 | **Cursor-walk cannot defer to v1.** 50-msg cap + outage = silent message loss. | P1 | Walk `earliestCursor` when `length===50 && hasOlder===true && oldest > local watermark`. Watermark per thread, sidecar-local. |
| C-15 | **Defer dual-mode in current form.** API mark-as-read + UI sees no unread = misclassifies. Move to "shadow mode": API runs in production but emissions go to a side channel; UI mode is the only callback emitter during shadow. | P1 | Spec §8 ADR-3: replace dual with shadow. |
| C-16 | **`forceUgcTranslation` must default false.** Auto-translation destroys NLP signal. | P2 | Spec §3 Op B: pin `forceUgcTranslation: false`. |
| C-17 | **Schema fingerprint check per cycle.** Hash 200 with degraded shape is the worst silent-failure mode. | P1 | Required-path assertion list: `data.threadData.id`, `messageData.messages[].id`, `account.accountId`, `createdAtMs`, `participants.edges[].node.accountId`, `expandedCursorsSegment`. Cycle aborts on missing required path. |

### Disputed issues — Q1 (most-dangerous P0)

Three reviewers picked three different #1s. Each is a real P0; the disagreement is about which is most-dangerous, not about whether all three need fixing.

| Reviewer | Pick | Argument |
|---|---|---|
| Opus | Silent thread-type drop | "Bad forever, no signal" beats "bad once, loud" |
| Gemini | Dedup storm (ID format mismatch) | SMS already delivered cannot be unsent; user-trust failure not recoverable by env flip |
| Codex | Wrong-host cookie risk | Cross-tenant data disclosure; hard rule "fail closed on weak thread identity" not actually implemented unless viewer is pinned |

**My assessment of the dispute:**

All three are P0 with different threat profiles:
- **Wrong-host (Codex):** highest severity (cross-tenant), lowest likelihood (HMAC + single-host config), low detectability. **Wins on severity.**
- **Silent thread-type drop (Opus):** moderate severity (per-thread loss), moderate likelihood (any non-MessageThread guest interaction), very low detectability. **Wins on stealth.**
- **Dedup storm (Gemini):** high severity at cutover (irreversible SMS spam), likelihood gated by promotion policy, instant detectability. **Wins on cutover-window risk.**

The right resolution is: **fix all three before merge.** Treat Codex's viewer-pinning, Gemini's ID-equivalence shadow-gate, and Opus's GID-from-response as three mandatory P0 gates. There is no single "#1" — picking one and shipping with the other two unmitigated would be malpractice.

### Disputed issues — Q3 (ship API or harden UI)

| Reviewer | Position | Core argument |
|---|---|---|
| Opus | SHIP API with bounded v0 cuts (5-step staged plan) | Strategic durability: operation names stable across years; auto-recovery on hash rotation. UI failure modes are intermittent partial loss with no signal — same blast-radius profile but happening *now* in production. |
| Codex | SHIP API with revisions | UI hardening cannot fix the substrate problem (thread navigation in virtualized SPA). API exposes typed fields + cursors + identity checks. |
| Gemini (R2 evolved) | "Drive UI + intercept SPA's own GraphQL responses" hybrid: avoid bare `fetch`, harvest JSON via `page.on('response')` matching `**/ViaductGetThreadAndDataQuery**` | Avoids WAF stack-trace fingerprinting; SPA manages auth lifecycle; no hash maintenance. |

**Specific cross-fire:**

- **Opus on Gemini's hybrid:** SPA inbox uses `react-window` virtualization — rows beyond viewport are not in the DOM at all. To force render, must scroll virtual container, which fires more SPA navigation, which destroys page state being parsed. Network-idle waiting cannot wait for data that's not requested. Hybrid does not solve the substrate problem.
- **Codex on Gemini's hybrid:** "Watching GraphQL responses while still depending on DOM navigation keeps the worst coupling: you must click each thread correctly, wait correctly, and parse rendered rows correctly." Plus: "It also cannot guarantee full history because the SPA may only request visible/current-window messages."
- **Gemini on Opus's recovery time:** Opus claimed "WAF-burn → 30-60 min via Claude-in-Chrome." Gemini countered: PerimeterX places a 24–48 hr velocity lock on host accounts; cannot click through. *Gemini's claim is plausible but unsourced* — neither reviewer has direct evidence of Airbnb's specific PX policy. Treat as a real risk to model.

**My assessment:**

Gemini's hybrid is clever but fails the stated production problem: thread enumeration is broken because virtualized SPA rows don't render reliably under headless Chromium. Network-idle waiting helps only if data is being fetched; in a virtualized list, scrolling-to-fetch is exactly the unreliable navigation surface this spec exists to remove. Codex's demolition is correct.

That said, Gemini surfaced two hardening ideas worth absorbing into the API path:
1. Where possible, harvest the SPA's own outbound GraphQL responses via `page.on('response')` *as a backup* to direct fetch, to corroborate ID-equivalence and as fallback when `page.evaluate(fetch)` raises.
2. Treat WAF-burn recovery as 24–48 hr risk, not 30–60 min, when sizing blast-radius.

**Verdict: SHIP API.** With Opus's bounded-scope cuts, Codex's identity gates, and Gemini's WAF severity recalibration.

---

### Missed considerations (none of the three named in either round)

- **Time-zone drift between sidecar and Airbnb server.** `createdAtMs` is server-side. If the sidecar's local clock skews >5s, watermark-based gap-fill can over- or under-walk. Use server-returned timestamps strictly.
- **Listing-level changes.** A new listing added to the host account between cycles will appear in the inbox without prior watermark. v0 must accept first sighting and emit full thread to callback. Cursor-walk for new threads should NOT walk `earliestCursor` on first sighting — cap at `numRequestedMessages` and let dedup be the single source of truth for first emission.
- **Localization mismatch.** Spec §3 query string includes `locale=en&currency=USD` regardless of what the SPA uses. If the SPA was loaded under `en-US` but the host's profile is `en-GB`, the API may serve `en-GB` payloads despite the URL hint. Probe v3 should sample both.

---

## Verdict

**Ship-with-fixes. Bounded-scope v0.**

The API replacement is the right strategic call (2-of-3 reviewers agree, with Codex's argument the strongest: the UI substrate problem cannot be fixed by better selectors). But the spec as drafted has 17 P0/P1 gaps. Path forward:

1. Capture probe v3 (3 captures: header inventory, `globalThreadId` direct from inbox response, `hydratedContent` shapes for top 5 contentTypes).
2. Sandbox read-mark test on a non-production Airbnb account.
3. Revise spec to v1 incorporating all C-1 through C-17, plus the 3 missed considerations.
4. Re-review (or skip if revisions are mechanical).
5. Implement v0.1: shadow mode, inbox-listing only, no callback writes (proves auth/identity/WAF/hash machinery).
6. Implement v0.2: thread-read with all identity gates.
7. Implement v0.3: full `hydratedContent` extraction, callback writes still in shadow.
8. Promote to canary only after ≥3 days of 0 ID-mismatches in shadow.

---

## Implementation Plan (ordered)

### Pre-merge gates (block any code commit)

1. **Probe v3** — capture: (a) all SPA-injected request headers, (b) `globalThreadId` value in `ViaductInboxData` response (confirm: it's an opaque string we extract, never compute), (c) `hydratedContent` structure for plain-text, rich-text, system-message, RTB, reaction-only, soft-deleted, alteration-request shapes, (d) PerimeterX challenge body (if triggerable in sandbox), (e) sample of `viewer` identity field if present in either operation.
2. **Sandbox read-mark test** — call `ViaductGetThreadAndDataQuery` with `getLastReads: false`, `forceReturnAllReadReceipts: false`, then re-check unread badge via separate session. Document. Repeat with each flag toggled to identify which marks-read.
3. **Spec v1 revision** — incorporate C-1 through C-17 plus missed considerations. Replace ADR-3 dual mode with shadow mode. Close open questions Q3 (alerting destination) and Q5 (multi-host = closed gate).
4. **Real fixtures committed** — `tests/fixtures/api-reader/` with 2 sanitized responses.

### v0.1 — Shadow mode, inbox-listing only

- New module `src/playwright/api-reader.ts` with `readInboxViaApi(page, opts)`.
- Calls `ViaductInboxData` only.
- Emits **diagnostic-only** stream (not the StaySync callback) listing thread metadata: `rawId`, `globalThreadId` (from response), `nodeType`, `lastMessageAtMs`, `participants.length`.
- Production runs in shadow alongside UI mode; UI is the sole callback emitter.
- Shadow signal validates: identity gates, WAF stability, hash health, schema fingerprint, authEpoch lock.

### v0.2 — Thread-read in shadow

- Add `ViaductGetThreadAndDataQuery` per-thread.
- All identity gates active: viewer pinning, per-thread participant must include host accountId, GID matches request.
- Sequential calls with 500–1500 ms jitter.
- Shadow comparison logs UI `data-item-id` vs API `msg.id`/`uuid`/`opaqueId` per message.

### v0.3 — `hydratedContent` extraction in shadow

- Implement `extractText` against captured shapes from probe v3.
- Allow-list of known content types; placeholder for unknowns (`text="[unsupported:contentType]"`).
- Shadow continues until ≥3 days 0 ID-mismatches AND text-extraction parity ≥99% on common content types.

### v0.4 — Promote to callback writes

- Flip env: `INBOX_READER_MODE=api`. UI mode remains as immediate rollback target.
- Watch DB counts for 1 hour. If any duplicate row appears or message-count delta diverges from shadow projection, env-flip back.
- Hash-rotation alert routed to callback diagnostic message type.

### v1 (deferred items)

- Auto-hash-recovery via SPA-XHR interception.
- Cursor walk older messages (with watermark protocol from C-14).
- Reaction emission with `parentMessageId` reconciliation.
- Archived/RequestThread/AlterationThread inbox visibility.
- `SyncProtocolSubscription` real-time channel evaluation.

### Hard blockers (will not ship without)

- Spec v1 commit with all C-issues addressed.
- Probe v3 captures committed (sanitized).
- Sandbox read-mark test result documented.
- Shadow-mode comparison telemetry path live.
- Rollback gate: env flip back to UI returns to known-good behavior in <60 s.

---

## Full transcripts

Saved separately:
- `/tmp/debate-r1-all.md` — Round 1 (all three reviewers)
- `/tmp/debate-r1-gemini.txt` — Gemini Round 1 verbatim
- `/tmp/debate-r1-codex-out.txt` — Codex Round 1 verbatim
- `/tmp/debate-r2-gemini.txt` — Gemini Round 2 verbatim
- `/tmp/debate-r2-codex-out.txt` — Codex Round 2 verbatim
- Opus Round 1 + Round 2 inline in this session
