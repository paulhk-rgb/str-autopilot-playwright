# API-Reader Fixtures

Sanitized real-Airbnb-API responses for `src/playwright/api-reader.ts` unit + integration tests.

## Files

| File | Source | Mix |
|---|---|---|
| `inbox-15-threads-mixed.json` | `ViaductInboxData` 2026-04-26 | 15 threads, includes 2/3-participant variants |
| `thread-with-mixed-content.json` | `ViaductGetThreadAndDataQuery` 2026-04-26 | 15 messages: 12 TEXT, 1 VIEWER_BASED (STAYS_INSTANT_BOOKED), 1 TEMPLATE (STAY_ALTERATION_PENDING), 1 VIEWER_BASED (STAY_ALTERATION_ACCEPTED) |
| `thread-with-media-content.json` | `ViaductGetThreadAndDataQuery` 2026-04-26 | 30 messages including MEDIA_CONTENT |

`STATIC_BULLETIN_CONTENT` was observed in another thread on the same day but isn't covered by these fixtures — extractor falls through to `[unsupported:contentType:STATIC_BULLETIN_CONTENT]` placeholder per spec §3 (P1-L). When probe v4 captures shape, add a fourth fixture.

## Sanitization rules

Applied via `scripts/fixture-sanitize.mjs`:

- **Names** (`firstName`, `lastName`, `fullName`, `displayName`, `smartName`, `preferredName`, `threadDisplayName`, `orderedParticipantsAccessibilityText`) → `[REDACTED:<key>]`
- **Contextual `name`** — value-shape heuristic. `EYE16`/`FLAG16`/etc. (icon enums) preserved; Title-Case persons redacted.
- **Bodies** (`body`, `bodyTranslated`, `plainText`, `previewContent`, `previewContentWithAutoTranslatedUGC`, `translatedContent`, `text`) → `[REDACTED:<key>]`
- **Contextual `content`** — non-enum strings redacted (e.g. `MessageContentPreview.content`); GraphQL enum strings preserved (e.g. `contentType`).
- **A11y copy** (`accessibilityText`, `accessibilityTextNonNull`, `accessibilityTemplateText`, `inboxAccessibilityTemplateText`, `caption`, `captionText`, `linkText`) → `[REDACTED:<key>]`
- **Booking-identifying** (`confirmationCode` → `FIXTURECODE`, `bessieThreadId` → `fixture-bessie-id`)
- **URLs** (any `https?://` value, plus any value at `url`/`href`/`sourceUrl`/`pictureUrl`/`profilePicUrl`/`thumbnailUrl`/`imageUrl`/`inboxListingImageUrl`/`uri`/`urlPath`/`iconUrl` keys) → `https://example.com/fixture-...`
- **Contact** (`email`, `phoneNumber`, etc.) → `[REDACTED:<key>]`

## Preserved (intentional)

- **Numeric IDs** — `accountId`, `id` (base64), `opaqueId`, `uuid`, `parentMessageId`, `correlationIdentifier`, raw thread IDs in decoded `globalThreadId`. Not PII without auth context; required for decode/equivalence tests.
- **GraphQL structure** — every `__typename`, every key, all enum values (`contentType`, `accountType`, `inboxItemHighlight`, etc.), all booleans, all timestamps.
- **Relay cursors** (`startCursor`, `endCursor`) — base64 JSON containing structural pagination state; required for cursor-walk tests.

## Regenerating

```bash
# 0. Set the host's globalUserId env var (NOT committed — ID lives only in your shell):
export AIRBNB_API_GLOBAL_USER_ID="$(echo -n 'Viewer:<NUMERIC_HOST_ID>' | base64)"

# 1. Capture fresh probe (writes to /tmp — NEVER commit; auto-cleaned in step 2)
node scripts/fixture-probe.mjs

# 2. Sanitize into committable form (also deletes /tmp/probe-fresh-*.json)
node scripts/fixture-sanitize.mjs

# 3. Optional: refresh local PII denylist for verifier
#    (a) cp scripts/.pii-denylist.template scripts/.pii-denylist
#    (b) edit scripts/.pii-denylist to add guest first names from your latest probe + host identifiers
#    The .pii-denylist file is gitignored — see .gitignore for why.

# 4. Verify no PII leaked
bash scripts/fixture-verify.sh
```

The probe requires:
- Chrome with CDP on `127.0.0.1:9222` (host Chrome instance)
- An open `airbnb.com/hosting/messages` tab logged into the probe target host
- `AIRBNB_API_GLOBAL_USER_ID` env var set (host's pre-computed `base64('Viewer:<numericId>')`)
- The persisted-query hashes pinned in `fixture-probe.mjs` still valid (else `PERSISTED_QUERY_NOT_FOUND` — see SPEC §3 for hash refresh path)
