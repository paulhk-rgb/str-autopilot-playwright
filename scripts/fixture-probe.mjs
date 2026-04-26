/**
 * One-shot probe to capture full Airbnb API responses for fixture sanitization.
 *
 * Captures:
 *   - /tmp/probe-fresh-inbox.json    — full ViaductInboxData response
 *   - /tmp/probe-fresh-thread-N.json — full ViaductGetThreadAndDataQuery responses
 *
 * Outputs are TEMP only — NEVER commit. Sanitize via scripts/fixture-sanitize.mjs
 * and commit only the sanitized fixtures.
 *
 * Usage:
 *   node scripts/fixture-probe.mjs
 */
import { chromium } from 'playwright';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';

// Persisted-query hashes — public values used by the SPA bundle. Pinned per spec §3.
const INBOX_HASH = process.env.AIRBNB_API_INBOX_HASH || 'ebeb240346015c12be36d76fd7003cbef5658e1c6d2e60b3554280b3c081aeea';
const THREAD_HASH = process.env.AIRBNB_API_THREAD_HASH || '9384287931cf3da66dd1fae72eb9d28e588de4066e05d34a657e30a9e9d2e9ef';

// Host's globalUserId. Set via env to keep individual host IDs out of git history.
// Format: base64('Viewer:' + numericAirbnbUserId). If unset, refuse to run.
const USER_ID_GLOBAL = process.env.AIRBNB_API_GLOBAL_USER_ID;
if (!USER_ID_GLOBAL) {
  console.error('[probe] FATAL: set AIRBNB_API_GLOBAL_USER_ID=base64("Viewer:<numericId>") env var.');
  console.error('[probe]        Example (replace NN): export AIRBNB_API_GLOBAL_USER_ID="$(echo -n Viewer:NN | base64)"');
  process.exit(2);
}

// Trace-ID generator — base36, rejection-sampled to eliminate b % 36 bias.
// See SPEC-airbnb-api-reader-v2.md §3 for the full rationale.
const TRACE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TRACE_REJECT_THRESHOLD = 252; // floor(256 / 36) * 36
function r28() {
  const out = new Array(28);
  let i = 0;
  while (i < 28) {
    const buf = randomBytes(28 - i + 8);
    for (const b of buf) {
      if (b >= TRACE_REJECT_THRESHOLD) continue;
      out[i++] = TRACE_CHARS[b % 36];
      if (i === 28) break;
    }
  }
  return out.join('');
}

function buildInboxUrl() {
  const variables = {
    userId: USER_ID_GLOBAL,
    numRequestedThreads: 15,
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
  const extensions = { persistedQuery: { version: 1, sha256Hash: INBOX_HASH } };
  return `https://www.airbnb.com/api/v3/ViaductInboxData/${INBOX_HASH}?operationName=ViaductInboxData&locale=en&currency=USD&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
}

function buildThreadUrl(rawId) {
  // NOTE: this script CONSTRUCTS a globalThreadId from a numeric rawId for INITIAL
  // INBOX-PICK targeting only — it's a one-shot fixture-capture tool, not the runtime
  // reader. The production reader (per SPEC-airbnb-api-reader-v2.md §2 GlobalThreadId)
  // MUST extract globalThreadId from the inbox response's `inboxItems.edges[].node.id`
  // and validate the prefix against ALLOWED_THREAD_PREFIXES — never construct.
  // Construction is acceptable here because (a) the rawIds we use were just decoded
  // from a fresh inbox response moments earlier and (b) we surround the call with the
  // `MessageThread:` prefix that production would also expect after decoding.
  const globalThreadId = Buffer.from('MessageThread:' + rawId).toString('base64');
  const variables = {
    globalThreadId,
    numRequestedMessages: 50,
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
  const extensions = { persistedQuery: { version: 1, sha256Hash: THREAD_HASH } };
  return `https://www.airbnb.com/api/v3/ViaductGetThreadAndDataQuery/${THREAD_HASH}?operationName=ViaductGetThreadAndDataQuery&locale=en&currency=USD&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
try {
  let page = null;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('hosting/messages')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) throw new Error('no /hosting/messages page in CDP');

  let clientVersion = null;
  page.on('request', req => {
    if (clientVersion) return;
    if (req.url().includes('/api/v3/')) {
      const v = req.headers()['x-client-version'];
      if (v) clientVersion = v;
    }
  });
  await page.waitForTimeout(1500);
  if (!clientVersion) {
    await page.reload({ waitUntil: 'networkidle' }).catch(()=>{});
    await page.waitForTimeout(2000);
  }
  if (!clientVersion) throw new Error('failed to capture x-client-version');

  const baseHeaders = {
    'x-airbnb-api-key': 'd306zoyjsyarp7ifhu67rjxn52tv0t20',
    'x-airbnb-graphql-platform': 'web',
    'x-airbnb-graphql-platform-client': 'minimalist-niobe',
    'x-airbnb-supports-airlock-v2': 'true',
    'x-niobe-short-circuited': 'true',
    'x-csrf-token': '',
    'x-csrf-without-token': '1',
    'content-type': 'application/json',
    'x-client-version': clientVersion,
  };
  const headersFor = () => ({
    ...baseHeaders,
    'x-airbnb-client-trace-id': r28(),
    'x-airbnb-network-log-link': r28(),
    'x-client-request-id': r28(),
  });

  // Fetch inbox
  console.error('[probe] fetching inbox');
  const inbox = await page.evaluate(async ({ url, headers }) => {
    const res = await fetch(url, { headers, credentials: 'include' });
    const body = await res.json();
    return { status: res.status, body };
  }, { url: buildInboxUrl(), headers: headersFor() });
  if (inbox.status !== 200) throw new Error(`inbox status ${inbox.status}`);
  writeFileSync('/tmp/probe-fresh-inbox.json', JSON.stringify(inbox.body, null, 2));
  const edges = inbox.body?.data?.node?.messagingInbox?.inboxItems?.edges || [];
  console.error(`[probe] inbox captured: ${edges.length} threads -> /tmp/probe-fresh-inbox.json`);

  // Pick threads to fetch — try to maximize content-type variety
  const rawIds = edges.slice(0, 5).map(e => {
    const dec = atob(e.node.id);
    return dec.startsWith('MessageThread:') ? dec.slice('MessageThread:'.length) : null;
  }).filter(Boolean);

  for (let i = 0; i < rawIds.length; i++) {
    const rawId = rawIds[i];
    console.error(`[probe] fetching thread ${i+1}/${rawIds.length} rawId=${rawId.slice(-4)}**** (last-4 only)`);
    await page.waitForTimeout(800 + Math.random() * 700);
    const t = await page.evaluate(async ({ url, headers }) => {
      const res = await fetch(url, { headers, credentials: 'include' });
      const body = await res.json();
      return { status: res.status, body };
    }, { url: buildThreadUrl(rawId), headers: headersFor() });
    if (t.status !== 200) {
      console.error(`[probe] thread fetch ${i+1} status ${t.status} — skipping`);
      continue;
    }
    writeFileSync(`/tmp/probe-fresh-thread-${i+1}.json`, JSON.stringify(t.body, null, 2));
    const msgs = t.body?.data?.threadData?.messageData?.messages || [];
    const cts = Array.from(new Set(msgs.map(m => m.contentType))).join(',');
    console.error(`[probe] thread ${i+1}: ${msgs.length} msgs, contentTypes=[${cts}] -> /tmp/probe-fresh-thread-${i+1}.json`);
  }

  console.error('[probe] DONE. Now run scripts/fixture-sanitize.mjs');
} finally {
  // For browsers obtained via chromium.connectOverCDP(), browser.close() releases
  // ONLY the CDP WebSocket connection — it does NOT terminate the underlying
  // Chrome process. Verified per Playwright docs / source. (browser.disconnect()
  // is not exposed on the Browser type — Sonnet R2 audit suggestion was based on
  // wrong API.) DO NOT use chromium.connectOverCDP() with a Playwright-launched
  // browser instance, where close() WOULD terminate the process.
  await browser.close().catch(()=>{});
}
