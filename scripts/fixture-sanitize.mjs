/**
 * Sanitize raw Airbnb API response captures into committable test fixtures.
 *
 * Reads /tmp/probe-fresh-inbox.json + /tmp/probe-fresh-thread-1.json,
 * writes tests/fixtures/api-reader/inbox-15-threads-mixed.json + thread-with-mixed-content.json.
 *
 * Redaction rules:
 *   - All string values for keys in PII_KEYS → placeholder by category.
 *   - All URL-shaped values → fixture URLs (regardless of key).
 *   - Numeric IDs in accountId/opaqueId/uuid/id are NOT PII without auth — preserved.
 *   - Numeric thread/message rawIds preserved (functionally opaque to non-auth callers).
 *
 * Sanity check after writing: run `npm run fixture:verify` (a grep-based audit).
 *
 * Usage:
 *   node scripts/fixture-sanitize.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';

// Keys whose STRING values must be redacted entirely. Values that are NOT strings
// (objects, arrays, booleans, numbers, null) recurse normally — only string leaves
// at these keys get replaced.
const PII_KEY_REPLACEMENTS = {
  // Names
  firstName: '[REDACTED:firstName]',
  lastName: '[REDACTED:lastName]',
  fullName: '[REDACTED:fullName]',
  displayName: '[REDACTED:displayName]',
  smartName: '[REDACTED:smartName]',
  preferredName: '[REDACTED:preferredName]',
  threadDisplayName: '[REDACTED:threadDisplayName]',
  orderedParticipantsAccessibilityText: '[REDACTED:orderedParticipantsAccessibilityText]',
  // Contact
  email: '[REDACTED:email]',
  emailAddress: '[REDACTED:emailAddress]',
  phoneNumber: '[REDACTED:phoneNumber]',
  phone: '[REDACTED:phone]',
  // Message bodies + translations
  body: '[REDACTED:body]',
  bodyTranslated: '[REDACTED:bodyTranslated]',
  plainText: '[REDACTED:plainText]',
  previewContent: '[REDACTED:previewContent]',
  previewContentWithAutoTranslatedUGC: '[REDACTED:previewContent]',
  translatedContent: '[REDACTED:translatedContent]',
  // Display copy
  linkText: '[REDACTED:linkText]',
  accessibilityText: '[REDACTED:accessibilityText]',
  accessibilityTextNonNull: '[REDACTED:accessibilityTextNonNull]',
  accessibilityTemplateText: '[REDACTED:accessibilityTemplateText]',
  inboxAccessibilityTemplateText: '[REDACTED:inboxAccessibilityTemplateText]',
  caption: '[REDACTED:caption]',
  captionText: '[REDACTED:captionText]',
  // Booking-identifying
  confirmationCode: 'FIXTURECODE',
  confirmationCodeMA: 'FIXTURECODE', // MessageAction variant — leaks real booking codes if missed
  bessieThreadId: 'fixture-bessie-id',
  reference_id: '[REDACTED:reference_id]', // CLSF-* AirCover claim IDs etc.
  message_unique_identifier: '[REDACTED:message_unique_identifier]', // event-correlation UUIDs
  // Free-text leaves likely to carry PII when populated
  guestName: '[REDACTED:guestName]',
  hostName: '[REDACTED:hostName]',
  listingName: '[REDACTED:listingName]',
  street: '[REDACTED:street]',
  city: '[REDACTED:city]',
  localizedLocation: '[REDACTED:localizedLocation]',
  subtitle: '[REDACTED:subtitle]',
  message: '[REDACTED:message]',
  description: '[REDACTED:description]',
  // Free-text leaves often containing PII
  text: '[REDACTED:text]',
  // 'content' is contextual — see redactContextual below.
  // 'name' is contextual — see redactContextual below.
};

// Keys that are dual-use: structural enum (icon names with digits/underscores) OR PII
// (e.g., real first/last names). Heuristic: if value matches Title-Case word(s) OR is a
// short all-caps token without digit/underscore, treat as PII; if UPPERCASE-with-digit-or-underscore,
// treat as enum.
const CONTEXTUAL_PII_KEYS = new Set(['name', 'content']);

// ENUM_LIKE per audit R2: short all-caps Latin tokens without a digit-or-underscore signal
// can bypass enum classification and would silently leak as `name` values. Real Airbnb GraphQL
// enums in observed responses universally either (a) include a digit (icon names: a Title16
// suffix, e.g. EYE16/FLAG16) or (b) include an underscore (TEXT_CONTENT, STAYS_INSTANT_BOOKED).
// Pure-alphabetic all-caps tokens are NOT classified as enums — safer to redact since they
// can be initials, short names, or rare codes.
const ENUM_LIKE = /^(?=.*[0-9_])[A-Z][A-Z0-9_]*$/;
// Title-case name patterns: 1+ Title-Case words separated by space/comma/period.
const TITLE_CASE_NAME = /^[A-Z][a-z]+(?:[ ,.][A-Z][a-z]+)*$/;
function looksLikeFreeText(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0) return false;
  if (ENUM_LIKE.test(s)) return false;
  return true;
}
function redactContextual(key, value) {
  if (typeof value !== 'string' || !value) return value;
  if (key === 'name') {
    // Icon enums like "EYE16", "FLAG16", "PERSONLARGE32" — keep.
    // Anything else (Latin Title Case, all-caps short names like "DJ", non-Latin
    // scripts like Cyrillic / CJK / Arabic, etc.) — redact. Per Gemini audit
    // 2026-04-26, the previous /[a-z]/ defensive fallback only catches Latin
    // lowercase, which would silently leak names in Cyrillic, Chinese, etc.
    return ENUM_LIKE.test(value) ? value : '[REDACTED:name]';
  }
  if (key === 'content') {
    // Free-text leaf in MessageContentPreview, etc. — redact ANY non-enum string.
    return looksLikeFreeText(value) ? '[REDACTED:content]' : value;
  }
  return value;
}

// URL-shaped values: replaced regardless of key, by category.
const URL_REPLACEMENTS = [
  // Profile / avatar URLs
  { test: u => /pictures\/users|profile/.test(u), value: 'https://example.com/fixture-profile.jpg' },
  // Listing images
  { test: u => /pictures\/(miso|hosting|airflow|prohost)/.test(u), value: 'https://example.com/fixture-listing.jpg' },
  // Generic Airbnb-served images
  { test: u => /a0\.muscache\.com/.test(u), value: 'https://example.com/fixture-image.jpg' },
  // Any other airbnb.com URL (deep links, hosting URLs)
  { test: u => /airbnb\.[a-z.]+/.test(u), value: 'https://example.com/fixture-airbnb-link' },
  // External tracking / CDN
  { test: u => /^https?:\/\//.test(u), value: 'https://example.com/fixture-external' },
];

const URL_KEYS_FORCED = new Set([
  'url','href','sourceUrl','pictureUrl','profilePicUrl','thumbnailUrl','imageUrl',
  'inboxListingImageUrl','uri','urlPath','iconUrl',
]);

function looksLikeUrl(s) {
  return typeof s === 'string' && /^https?:\/\//.test(s);
}

function replaceUrl(s) {
  for (const r of URL_REPLACEMENTS) {
    if (r.test(s)) return r.value;
  }
  return 'https://example.com/fixture-other';
}

function sanitize(node, parentKey = null) {
  if (Array.isArray(node)) {
    return node.map(item => sanitize(item, parentKey));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = sanitize(v, k);
    }
    return out;
  }
  if (typeof node === 'string') {
    // 1. Forced URL keys: if value is URL-shaped (or even non-URL but key is URL), replace.
    if (URL_KEYS_FORCED.has(parentKey)) {
      if (looksLikeUrl(node)) return replaceUrl(node);
      // Some URL-typed fields hold paths — preserve empty strings + nulls intact otherwise.
      if (node === '') return '';
      return 'https://example.com/fixture-url-key';
    }
    // 2. Any URL value, regardless of key, gets replaced.
    if (looksLikeUrl(node)) return replaceUrl(node);
    // 3. PII key replacements.
    if (parentKey && Object.prototype.hasOwnProperty.call(PII_KEY_REPLACEMENTS, parentKey)) {
      return PII_KEY_REPLACEMENTS[parentKey];
    }
    // 4. Contextual PII (dual-use keys, value-shape heuristic).
    if (parentKey && CONTEXTUAL_PII_KEYS.has(parentKey)) {
      return redactContextual(parentKey, node);
    }
    return node;
  }
  return node;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeFixture(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
  console.error(`[sanitize] wrote ${path}`);
}

const FIXTURE_DIR = 'tests/fixtures/api-reader';
mkdirSync(FIXTURE_DIR, { recursive: true });

// Inbox
const inboxRaw = readJson('/tmp/probe-fresh-inbox.json');
const inboxClean = sanitize(inboxRaw);
writeFixture(`${FIXTURE_DIR}/inbox-15-threads-mixed.json`, inboxClean);

// Thread (thread-1 — has TEMPLATE_CONTENT + VIEWER_BASED_CONTENT + TEXT_CONTENT mix)
const threadRaw = readJson('/tmp/probe-fresh-thread-1.json');
const threadClean = sanitize(threadRaw);
writeFixture(`${FIXTURE_DIR}/thread-with-mixed-content.json`, threadClean);

// Optional second thread for MEDIA_CONTENT coverage
try {
  const thread3Raw = readJson('/tmp/probe-fresh-thread-3.json');
  const thread3Clean = sanitize(thread3Raw);
  writeFixture(`${FIXTURE_DIR}/thread-with-media-content.json`, thread3Clean);
} catch (e) {
  console.error('[sanitize] thread-3 absent — skipping media fixture');
}

// Hygiene: delete the raw /tmp/probe-fresh-*.json captures. They are full PII;
// having them on disk after sanitization is a leak waiting to happen.
try {
  for (const name of readdirSync('/tmp')) {
    if (!name.startsWith('probe-fresh-') || !name.endsWith('.json')) continue;
    const path = `/tmp/${name}`;
    try { unlinkSync(path); console.error(`[sanitize] cleaned up ${path}`); } catch (e) { /* ignore */ }
  }
} catch (e) {
  console.error('[sanitize] could not enumerate /tmp for cleanup:', e.message);
}

console.error('[sanitize] DONE — verify with: bash scripts/fixture-verify.sh');
