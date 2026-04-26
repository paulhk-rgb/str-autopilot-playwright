#!/bin/bash
# PII grep audit for sanitized artifacts.
#
# Two scopes:
#   - tests/fixtures/api-reader/  (fixtures must be 100% sanitized)
#   - specs/                       (spec files: also no real guest names, but real
#                                   numeric IDs like host accountId are intentionally
#                                   pinned — flag only narrative leaks.)
#
# Failure on any pattern below: exits 1, lists locations.
#
# Usage: bash scripts/fixture-verify.sh
set -uo pipefail

FIXTURE_DIR="tests/fixtures/api-reader"
SPECS_DIR="specs"
[ -d "$FIXTURE_DIR" ] || { echo "fixture dir missing: $FIXTURE_DIR" >&2; exit 1; }

fail=0
report() { echo "FAIL: $1" >&2; fail=1; }

# ===== Structural: every PII key in sanitizer must hold either [REDACTED:*] or null
# Catches sanitizer drift (e.g. if a new dual-use key gets a real value).
# IMPORTANT: matches MUST NOT be printed verbatim — that would re-leak PII into CI logs.
# Print only file:line counts.
echo "=== structural PII-key audit ===" >&2
PII_KEYS_STRUCTURAL=(firstName lastName fullName displayName smartName preferredName threadDisplayName orderedParticipantsAccessibilityText email emailAddress phoneNumber phone body bodyTranslated plainText previewContent previewContentWithAutoTranslatedUGC translatedContent linkText accessibilityText accessibilityTextNonNull accessibilityTemplateText inboxAccessibilityTemplateText caption captionText confirmationCode confirmationCodeMA reference_id message_unique_identifier guestName hostName listingName street city localizedLocation subtitle message description text)
for key in "${PII_KEYS_STRUCTURAL[@]}"; do
  # Find any quoted "key": "<value>" where value is a non-null string AND does NOT start with [REDACTED OR FIXTURE
  count=$(grep -rEho "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$FIXTURE_DIR" 2>/dev/null \
          | grep -cvE "\"$key\"[[:space:]]*:[[:space:]]*\"(\\[REDACTED|FIXTURE|fixture-|https://example\.com)" 2>/dev/null || true)
  count=${count:-0}
  if [ "$count" -gt 0 ] 2>/dev/null; then
    report "structural: '$key' has $count unredacted string value(s) — re-run sanitizer"
  fi
done

# ===== Booking confirmation codes (HM[A-Z0-9]{8,12}) — count only, do not print
echo "=== booking-code regex audit ===" >&2
hm_count=$(grep -rEho '"HM[A-Z0-9]{8,12}"' "$FIXTURE_DIR" 2>/dev/null | wc -l | tr -d ' ')
if [ "${hm_count:-0}" -gt 0 ] 2>/dev/null; then
  report "Airbnb confirmation code pattern (HM[A-Z0-9]{8,12}) detected: $hm_count occurrences"
fi

# ===== AirCover / claim references — match the actual identifier shapes,
# NOT the structural reference_type enums like "aircover.achClaimGuardrailClosed"
# which carry no per-person info.
echo "=== aircover/claim audit ===" >&2
if grep -rEi 'CLSF-[0-9]+' "$FIXTURE_DIR" 2>/dev/null >/dev/null; then
  report "AirCover claim identifier (CLSF-N) detected"
fi

# ===== Identifier denylist — read from local untracked file at .pii-denylist
# Format: one line per term. Blank lines and lines starting with '#' are ignored.
# The file is gitignored intentionally — committing real names here would be a
# PII leak in scripts/, even though they're "just for verification" (Codex R3 audit
# 2026-04-26).
#
# If the file is missing, the audit only relies on the structural and pattern checks
# above. Run `node scripts/fixture-probe.mjs` (which writes to /tmp) and pull names
# from that data into a local copy of `.pii-denylist`.
echo "=== identifier-denylist audit ===" >&2
DENYLIST_FILE="scripts/.pii-denylist"
if [ -f "$DENYLIST_FILE" ]; then
  while IFS= read -r term; do
    [ -z "$term" ] && continue
    [ "${term:0:1}" = "#" ] && continue
    for dir in "$FIXTURE_DIR" "$SPECS_DIR" "scripts"; do
      [ -d "$dir" ] || continue
      # Exclude the denylist file itself from the scan (else it always self-matches).
      if grep -r --exclude="$(basename "$DENYLIST_FILE")" -i -w "$term" "$dir" >/dev/null 2>&1; then
        report "denylist term leaked in $dir/ — re-run sanitize"
      fi
    done
  done < "$DENYLIST_FILE"
else
  echo "  (no $DENYLIST_FILE — skipping identifier-denylist audit; structural + regex audits remain in force)" >&2
fi

# ===== E.164 phone-shaped strings
echo "=== phone audit ===" >&2
if grep -rE '"\+[0-9]{10,15}"' "$FIXTURE_DIR" >/dev/null 2>&1; then
  report "E.164 phone-shaped string detected"
fi

# ===== Email-shape
echo "=== email audit ===" >&2
if grep -rE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' "$FIXTURE_DIR" >/dev/null 2>&1; then
  report "email-shaped string in fixture"
fi

# ===== Domain leaks (sanitizer should have replaced)
echo "=== URL audit ===" >&2
if grep -rE 'https?://[^"]*airbnb\.[a-z.]+' "$FIXTURE_DIR" >/dev/null 2>&1; then
  report "airbnb URL leaked"
fi
if grep -rE 'https?://[^"]*muscache\.com' "$FIXTURE_DIR" >/dev/null 2>&1; then
  report "muscache URL leaked"
fi

# ===== Address / booking-detail signals
echo "=== address audit ===" >&2
for addr_signal in "miles from" "Bedroom" "commons" "Currently hosting" "Confirmed ·"; do
  if grep -r -i "$addr_signal" "$FIXTURE_DIR" >/dev/null 2>&1; then
    report "address/booking-detail '$addr_signal' leaked"
  fi
done

if [ $fail -eq 0 ]; then
  echo "OK — fixtures + specs pass PII audit."
  exit 0
else
  echo "FAIL — patch sanitizer / spec text and re-run." >&2
  exit 1
fi
