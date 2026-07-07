# str-autopilot-playwright — Fly worker (per-host Airbnb browser machines)

Express + Playwright sidecar deployed as per-host Fly machines (app `str-autopilot-playwright`). Machines are created by staysync-app's `playwright-session-provision` Inngest function with env `HOST_ID / CALLBACK_URL / HMAC_SECRET / AIRBNB_API_USER_ID (+ optional AIRBNB_API_CLIENT_VERSION)`; everything else uses baked defaults in `src/lib/env.ts`.

## DEPLOY COUPLING (the gotcha that bites)
Machines run a **pinned image digest** from Vercel env `PLAYWRIGHT_IMAGE_DIGEST` — merging to main does NOT change prod behavior. Ship order:
1. `fly deploy` (or build+push image) → get new digest
2. Update `PLAYWRIGHT_IMAGE_DIGEST` in Vercel (staysync-app)
3. Existing machines keep the old image until recreated (`playwright/session.requested` reprovision or `fly machine update`)

## Inbox reading architecture (v0.3+)
- `INBOX_READER_MODE` env: `ui` (prod default) / `shadow` / `api`. Dispatch in `src/endpoints/sync.ts`.
- API reader (`src/playwright/api-reader.ts` + `api-reader-cycle.ts`): in-page GraphQL (ViaductInboxData / ViaductGetThreadAndDataQuery) gated by (1) authEpoch.ready (in-memory — false after machine restart until next /inject-cookies) and (2) SPA observation (needs inboxHash/threadHash/x-client-version seen from organic traffic; hashes have env-pinned defaults, clientVersion falls back to `AIRBNB_API_CLIENT_VERSION` env or skips).
- Targeted syncs (`target_thread_ids` in /sync body, ≤20 raw ids): API reader is authority; **UI reader (`scrapeInbox` with `targetThreadIds`) is the fallback** when the API cycle errors — a targeted sync must NEVER silently no-op (prod incident 2026-07-04: all gate-skips/thread-drops returned ok + zero callbacks while the app recorded success).
- Cycle contract: recoverable per-thread failures drop the thread and continue, BUT a targeted cycle where ALL targets fail returns `ok:false, apiSkipReason='all_target_threads_failed'`.
- Watermarks (`/data/profile/watermarks.json`): api-mode advances commit only AFTER all callback batches return 2xx.

## System-event emission (spec v1.17, PR #34, 2026-07-07)
- Both legs emit `sender: 'guest' | 'host' | 'system'` (`ScrapedMessage` in api-reader.ts AND scrape-inbox.ts — two separate defs, keep in sync). App accepts `system` since staysync-app #643 (persists `message_type='system'`, quarantines `[template:…]`-class tokens).
- API leg: `extractCardHeaderText` resolves card text from `headerV2.tombstoneHeader` / `headerV2.actionHeader` / `MessagingCardV2 sections[]` (RichFormatText `tags[].body` — probe 2026-07-07). Resolved system events EMIT (no longer dropped); empty-tombstone USER templates emit the token under `sender:'system'`, NEVER guest/host. `EXTERNAL_SERVICE` accountType = origin-invariant exempt like SERVICE (`SERVICE_ACCOUNT_TYPES`). One-id-one-sender enforced in-page. Diagnostics: `systemEmitted`, `emptyTemplateTombstones` (>0 = extraction gap → probe the new card subtype); `droppedSystem` now counts only placeholder/defensive drops.
- DOM leg: card groups whose parsed aria text EXACTLY equals Airbnb fallback copy ("message but description not available", "Suggestion: Change reservation") → senderType 'system' (dropped at the scrapeInbox filter). Exact list mirrors staysync `system-message-artifacts.ts` — never prefix-match.
- Fixture `tests/fixtures/api-reader/thread-with-rtb-cards.json` (synthetic) covers all card shapes; `tests/scrape-inbox-cards.test.ts` drives the real readThread evaluate callback via a fake Page.

## Callback semantics
`/sync` posts `sync_messages_batch` pages (≤50) to CALLBACK_URL; always ends with a `has_more:false` closure batch EXCEPT when zero messages AND (`sync_time_budget_exhausted` or `target_api_failed:`) — suppressed so the app doesn't mistake a failed sync for a clean empty one. The staysync-app `initial-sync` step parses response `errors[]`; non-empty → `completedWithoutErrors:false` (non-fatal for sync-only flows — provision `onFailure` DESTROYS the machine, so sync errors must never throw there).

## Dev
- `npx vitest run` (tests in `tests/`), `npx tsc --noEmit`. Test fixtures for the API reader in `tests/fixtures/api-reader/`.
- Machine spec §refs in code comments refer to SPEC-historical-sync / playwright specs in staysync-app.
