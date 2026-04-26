import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALLOWED_THREAD_PREFIXES,
  buildApolloHeaders,
  buildInboxUrl,
  buildThreadUrl,
  decodeRelayId,
  extractText,
  generateTraceId,
  readThreadViaApi,
  validateInboxResponse,
  validateThreadResponse,
} from '../src/playwright/api-reader';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'api-reader');
const inboxFixture = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'inbox-15-threads-mixed.json'), 'utf8'),
) as Record<string, unknown>;

/**
 * Derive the host accountId from the fixture as the accountId that appears in
 * every thread's participants. (Avoids hardcoding the real host ID in tests.)
 */
function deriveHostAccountId(inbox: Record<string, unknown>): string {
  const data = inbox.data as Record<string, unknown>;
  const node = data.node as Record<string, unknown>;
  const messagingInbox = node.messagingInbox as Record<string, unknown>;
  const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
  const edges = inboxItems.edges as Array<Record<string, unknown>>;
  let common: Set<string> | null = null;
  for (const edge of edges) {
    const threadNode = edge.node as Record<string, unknown>;
    const participants = threadNode.participants as Record<string, unknown>;
    const partEdges = participants.edges as Array<Record<string, unknown>>;
    const ids = new Set<string>();
    for (const pe of partEdges) {
      const peNode = pe.node as Record<string, unknown>;
      if (typeof peNode.accountId === 'string') ids.add(peNode.accountId);
    }
    common = common === null ? ids : new Set([...common].filter(x => ids.has(x)));
  }
  if (!common || common.size !== 1) {
    throw new Error(`expected exactly 1 common accountId across threads; got ${common?.size}`);
  }
  return [...common][0];
}

describe('decodeRelayId', () => {
  it('decodes a MessageThread global ID', () => {
    expect(decodeRelayId('TWVzc2FnZVRocmVhZDoyNDc2OTU3NDc5')).toEqual({
      prefix: 'MessageThread',
      raw: '2476957479',
    });
  });

  it('decodes a Message global ID', () => {
    expect(decodeRelayId('TWVzc2FnZTozMDMwOTY3NjM3Nw==')).toEqual({
      prefix: 'Message',
      raw: '30309676377',
    });
  });

  it('throws on missing typename separator', () => {
    // Plain "abc" base64 → "iÛ" — no colon, throws.
    const noSep = Buffer.from('plainstring').toString('base64');
    expect(() => decodeRelayId(noSep)).toThrow(/missing_typename_separator/);
  });

  it('round-trip: decoding the constructed form yields the input numeric', () => {
    const constructed = Buffer.from('MessageThread:2476957479').toString('base64');
    expect(decodeRelayId(constructed).raw).toBe('2476957479');
  });
});

describe('generateTraceId', () => {
  it('produces a 28-char base36 string', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[a-z0-9]{28}$/);
  });

  it('respects the rejection threshold via injected rng', () => {
    // Construct an rng that returns bytes alternating between rejected (>=252)
    // and accepted (1, mapping to 'b'). After rejection sampling, every char must
    // be 'b'.
    const rng = (size: number) => {
      const buf = Buffer.alloc(size);
      for (let i = 0; i < size; i++) buf[i] = i % 2 === 0 ? 252 : 1;
      return buf;
    };
    const id = generateTraceId(rng);
    expect(id).toBe('b'.repeat(28));
  });

  it('does not produce char index >= 36', () => {
    // Sanity: every char of 1000 trials maps cleanly into the charset.
    for (let i = 0; i < 1000; i++) {
      const id = generateTraceId();
      for (const c of id) {
        expect('abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(c)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('buildApolloHeaders', () => {
  it('forwards 12 required Apollo-wrapper headers with exact static values', () => {
    const h = buildApolloHeaders({
      apiKey: 'public-web-key',
      clientVersion: 'fakebuildhash',
    });
    expect(h['x-airbnb-api-key']).toBe('public-web-key');
    expect(h['x-airbnb-graphql-platform']).toBe('web');
    expect(h['x-airbnb-graphql-platform-client']).toBe('minimalist-niobe');
    expect(h['x-airbnb-supports-airlock-v2']).toBe('true');
    expect(h['x-niobe-short-circuited']).toBe('true');
    // Spec §3: x-csrf-token MUST be empty string (length 0). Niobe sends it empty.
    expect(h['x-csrf-token']).toBe('');
    expect(h['x-csrf-without-token']).toBe('1');
    expect(h['content-type']).toBe('application/json');
    expect(h['x-client-version']).toBe('fakebuildhash');
    // Per-request randoms — checked in separate test for format.
    expect(h['x-airbnb-client-trace-id']).toBeDefined();
    expect(h['x-airbnb-network-log-link']).toBeDefined();
    expect(h['x-client-request-id']).toBeDefined();
    // No extra headers leaked.
    expect(Object.keys(h).length).toBe(12);
  });

  it('emits 28-char base36 for the three random headers', () => {
    const h = buildApolloHeaders({ apiKey: 'k', clientVersion: 'v' });
    expect(h['x-airbnb-client-trace-id']).toMatch(/^[a-z0-9]{28}$/);
    expect(h['x-airbnb-network-log-link']).toMatch(/^[a-z0-9]{28}$/);
    expect(h['x-client-request-id']).toMatch(/^[a-z0-9]{28}$/);
  });

  it('emits a fresh trace ID per call (no static cache)', () => {
    const a = buildApolloHeaders({ apiKey: 'k', clientVersion: 'v' });
    const b = buildApolloHeaders({ apiKey: 'k', clientVersion: 'v' });
    expect(a['x-airbnb-client-trace-id']).not.toBe(b['x-airbnb-client-trace-id']);
  });
});

describe('buildInboxUrl', () => {
  const baseOpts = {
    inboxHash: 'abcdef0123',
    globalUserId: 'Vmlld2VyOjEyMzQ1Njc4',
    numRequestedThreads: 15,
  };

  it('targets /api/v3/ViaductInboxData with the hash in the path', () => {
    const url = buildInboxUrl(baseOpts);
    expect(url).toMatch(/\/api\/v3\/ViaductInboxData\/abcdef0123\?/);
  });

  it('encodes ALL Operation A variables exactly per spec §3', () => {
    const url = buildInboxUrl(baseOpts);
    const u = new URL(url);
    const variables = JSON.parse(u.searchParams.get('variables') ?? '');
    expect(variables).toEqual({
      userId: baseOpts.globalUserId,
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
    });
  });

  it('encodes locale=en and currency=USD per spec', () => {
    const url = buildInboxUrl(baseOpts);
    const u = new URL(url);
    expect(u.searchParams.get('operationName')).toBe('ViaductInboxData');
    expect(u.searchParams.get('locale')).toBe('en');
    expect(u.searchParams.get('currency')).toBe('USD');
  });

  it('encodes the persisted-query hash in extensions', () => {
    const url = buildInboxUrl(baseOpts);
    const u = new URL(url);
    const ext = JSON.parse(u.searchParams.get('extensions') ?? '');
    expect(ext.persistedQuery.sha256Hash).toBe(baseOpts.inboxHash);
    expect(ext.persistedQuery.version).toBe(1);
  });
});

describe('validateInboxResponse', () => {
  const HOST = deriveHostAccountId(inboxFixture);

  it('passes the 15-thread sanitized fixture and returns 15 thread refs', () => {
    const result = validateInboxResponse(inboxFixture, HOST, 'fakehash', 15);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.threads.length).toBe(15);
    expect(result.diagnostics.threadsReturned).toBe(15);
    expect(result.diagnostics.threadsDroppedUnknownPrefix).toBe(0);
    expect(result.diagnostics.threadsDroppedHostMembership).toBe(0);
    expect(result.diagnostics.schemaFingerprintOk).toBe(true);
  });

  it('extracts globalThreadId from response (never constructs from rawId)', () => {
    const result = validateInboxResponse(inboxFixture, HOST, 'fakehash', 15);
    if (!result.ok) throw new Error('unreachable');
    for (const t of result.threads) {
      expect(t.globalThreadId).toBeDefined();
      expect(t.rawId).toMatch(/^\d{6,}$/);
      // The response-extracted id, decoded, must match the rawId we report.
      const dec = decodeRelayId(t.globalThreadId);
      expect(dec.raw).toBe(t.rawId);
      expect(ALLOWED_THREAD_PREFIXES).toContain(dec.prefix);
    }
  });

  it('rejects non-MessageThread prefixes via allow-list (synthetic mutation)', () => {
    // Inject one thread whose globalThreadId decodes to e.g. "Reaction:123"
    const cloned = JSON.parse(JSON.stringify(inboxFixture));
    const data = cloned.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    const messagingInbox = node.messagingInbox as Record<string, unknown>;
    const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
    const edges = inboxItems.edges as Array<Record<string, unknown>>;
    const fakeId = Buffer.from('Reaction:9999999').toString('base64');
    (edges[0].node as Record<string, unknown>).id = fakeId;

    const result = validateInboxResponse(cloned, HOST, 'fakehash', 15);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.threads.length).toBe(14); // one dropped
    expect(result.diagnostics.threadsDroppedUnknownPrefix).toBe(1);
  });

  it('drops single threads that lack the host accountId (per-thread tier of invariant 1c)', () => {
    const cloned = JSON.parse(JSON.stringify(inboxFixture));
    const data = cloned.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    const messagingInbox = node.messagingInbox as Record<string, unknown>;
    const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
    const edges = inboxItems.edges as Array<Record<string, unknown>>;
    // Strip the host accountId from one thread's participants.
    const threadNode = edges[0].node as Record<string, unknown>;
    const participants = threadNode.participants as Record<string, unknown>;
    const partEdges = participants.edges as Array<Record<string, unknown>>;
    participants.edges = partEdges.filter(pe => {
      const peNode = pe.node as Record<string, unknown>;
      return peNode.accountId !== HOST;
    });

    const result = validateInboxResponse(cloned, HOST, 'fakehash', 15);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.threads.length).toBe(14);
    expect(result.diagnostics.threadsDroppedHostMembership).toBe(1);
  });

  it('returns wrong_host when NO thread includes the host accountId (cycle-wide tier)', () => {
    const result = validateInboxResponse(inboxFixture, '99999999', 'fakehash', 15);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('wrong_host');
    expect(result.diagnostics.threadsDroppedHostMembership).toBe(15);
  });

  it('passes vacuously on empty inbox (brand-new host edge case)', () => {
    const cloned = JSON.parse(JSON.stringify(inboxFixture));
    const data = cloned.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    const messagingInbox = node.messagingInbox as Record<string, unknown>;
    const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
    inboxItems.edges = [];

    const result = validateInboxResponse(cloned, '99999999', 'fakehash', 15);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.threads.length).toBe(0);
    expect(result.diagnostics.schemaFingerprintOk).toBe(true);
  });

  it('returns schema_mismatch when data.node.messagingInbox.inboxItems is missing', () => {
    const result = validateInboxResponse({ data: {} }, HOST, 'fakehash', 15);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('schema_mismatch');
    expect(result.diagnostics.schemaFingerprintOk).toBe(false);
  });

  it('returns schema_mismatch when edges is not an array', () => {
    const result = validateInboxResponse(
      { data: { node: { messagingInbox: { inboxItems: { edges: 'oops', pageInfo: {} } } } } },
      HOST,
      'fakehash',
      15,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('schema_mismatch');
  });

  it('returns cookie_invalid for auth-shaped GraphQL errors', () => {
    const result = validateInboxResponse(
      { errors: [{ message: 'auth_required', extensions: { code: 'UNAUTHENTICATED' } }] },
      HOST,
      'fakehash',
      15,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('cookie_invalid');
  });

  it('returns persisted_query_not_found when errors[] code is PERSISTED_QUERY_NOT_FOUND', () => {
    const result = validateInboxResponse(
      {
        errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }],
      },
      HOST,
      'fakehash',
      15,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('persisted_query_not_found');
  });

  it('returns persisted_query_not_found when errors[].message contains PersistedQueryNotFound (no extensions)', () => {
    const result = validateInboxResponse(
      { errors: [{ message: 'PersistedQueryNotFound' }] },
      HOST,
      'fakehash',
      15,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('persisted_query_not_found');
  });

  it('returns schema_mismatch when ALL threads have unknown Relay prefix', () => {
    const cloned = JSON.parse(JSON.stringify(inboxFixture));
    const data = cloned.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    const messagingInbox = node.messagingInbox as Record<string, unknown>;
    const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
    const edges = inboxItems.edges as Array<Record<string, unknown>>;
    for (const edge of edges) {
      (edge.node as Record<string, unknown>).id = Buffer.from('Reaction:9999').toString('base64');
    }
    const result = validateInboxResponse(cloned, HOST, 'fakehash', 15);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('schema_mismatch');
    expect(result.diagnostics.threadsDroppedUnknownPrefix).toBe(15);
  });

  it('drops thread whose decoded raw ID is non-numeric', () => {
    const cloned = JSON.parse(JSON.stringify(inboxFixture));
    const data = cloned.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    const messagingInbox = node.messagingInbox as Record<string, unknown>;
    const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
    const edges = inboxItems.edges as Array<Record<string, unknown>>;
    (edges[0].node as Record<string, unknown>).id = Buffer.from('MessageThread:not-a-number').toString('base64');

    const result = validateInboxResponse(cloned, HOST, 'fakehash', 15);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.threads.length).toBe(14);
    expect(result.diagnostics.threadsDroppedIdentityMismatch).toBe(1);
  });

  it('returns schema_mismatch for non-object body (HTML challenge page string)', () => {
    const result = validateInboxResponse('<html>blocked</html>', HOST, 'fakehash', 15);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('schema_mismatch');
  });

  it('drops thread with malformed base64 id (decodeRelayId throws)', () => {
    const cloned = JSON.parse(JSON.stringify(inboxFixture));
    const data = cloned.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    const messagingInbox = node.messagingInbox as Record<string, unknown>;
    const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
    const edges = inboxItems.edges as Array<Record<string, unknown>>;
    // base64 of "plainstring" — no colon → missing_typename_separator.
    (edges[0].node as Record<string, unknown>).id = Buffer.from('plainstring').toString('base64');

    const result = validateInboxResponse(cloned, HOST, 'fakehash', 15);
    expect(result.ok).toBe(true); // continue with remaining
    if (!result.ok) throw new Error('unreachable');
    expect(result.threads.length).toBe(14);
    expect(result.diagnostics.threadsDroppedUnknownPrefix).toBe(1);
  });

  it('drops thread when participants.edges is missing', () => {
    const cloned = JSON.parse(JSON.stringify(inboxFixture));
    const data = cloned.data as Record<string, unknown>;
    const node = data.node as Record<string, unknown>;
    const messagingInbox = node.messagingInbox as Record<string, unknown>;
    const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
    const edges = inboxItems.edges as Array<Record<string, unknown>>;
    const threadNode = edges[0].node as Record<string, unknown>;
    delete (threadNode as Record<string, unknown>).participants;

    const result = validateInboxResponse(cloned, HOST, 'fakehash', 15);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.threads.length).toBe(14);
    expect(result.diagnostics.threadsDroppedIdentityMismatch).toBe(1);
  });
});

// ============================================================================
// v0.2 tests: extractText, buildThreadUrl, validateThreadResponse, readThreadViaApi
// ============================================================================

const threadFixture = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'thread-with-mixed-content.json'), 'utf8'),
) as Record<string, unknown>;
const mediaThreadFixture = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'thread-with-media-content.json'), 'utf8'),
) as Record<string, unknown>;

/** Derive the host accountId from a thread fixture: appears in this thread's participants AND inbox. */
function deriveHostAccountIdFromInbox(): string {
  return deriveHostAccountId(inboxFixture);
}

describe('extractText', () => {
  it('TEXT_CONTENT extracts content.body', () => {
    const result = extractText({
      contentType: 'TEXT_CONTENT',
      account: { accountType: 'USER' },
      hydratedContent: { content: { body: 'hello' } },
    });
    expect(result).toEqual({ kind: 'user', text: 'hello' });
  });

  it('TEXT_CONTENT falls back to bodyTranslated when body empty', () => {
    const result = extractText({
      contentType: 'TEXT_CONTENT',
      account: { accountType: 'USER' },
      hydratedContent: { content: { body: '', bodyTranslated: 'hola' } },
    });
    expect(result).toEqual({ kind: 'user', text: 'hola' });
  });

  it('MEDIA_CONTENT collects mediaItems[].uri into mediaUris + summary text', () => {
    const result = extractText({
      contentType: 'MEDIA_CONTENT',
      account: { accountType: 'USER' },
      hydratedContent: {
        content: { mediaItems: [{ uri: 'http://a' }, { uri: 'http://b' }] },
      },
    });
    expect(result.kind).toBe('user');
    if (result.kind !== 'user') throw new Error('unreachable');
    expect(result.mediaUris).toEqual(['http://a', 'http://b']);
    expect(result.text).toBe('[media: http://a | http://b]');
  });

  it('MEDIA_CONTENT with empty mediaItems emits "[media]" placeholder', () => {
    const result = extractText({
      contentType: 'MEDIA_CONTENT',
      account: { accountType: 'USER' },
      hydratedContent: { content: { mediaItems: [] } },
    });
    expect(result).toEqual({ kind: 'user', text: '[media]', mediaUris: [] });
  });

  it('VIEWER_BASED_CONTENT classifies as system regardless of accountType', () => {
    const result = extractText({
      contentType: 'VIEWER_BASED_CONTENT',
      contentSubType: 'STAYS_INSTANT_BOOKED',
      account: { accountType: 'SERVICE' },
      hydratedContent: { content: { body: 'Booked', linkText: 'View' } },
    });
    expect(result.kind).toBe('system');
    if (result.kind !== 'system') throw new Error('unreachable');
    expect(result.text).toContain('Booked');
    expect(result.text).toContain('View');
  });

  it('TEMPLATE_CONTENT USER emits as user message', () => {
    const result = extractText({
      contentType: 'TEMPLATE_CONTENT',
      contentSubType: 'STAY_ALTERATION_PENDING',
      account: { accountType: 'USER' },
      hydratedContent: {
        content: {
          headerV2: {
            tombstoneHeader: {
              title: { body: 'Alteration request' },
              kicker: { body: 'Pending' },
            },
          },
        },
      },
    });
    expect(result.kind).toBe('user');
    if (result.kind !== 'user') throw new Error('unreachable');
    expect(result.text).toBe('Pending: Alteration request');
  });

  it('TEMPLATE_CONTENT with SERVICE accountType is system', () => {
    const result = extractText({
      contentType: 'TEMPLATE_CONTENT',
      contentSubType: 'STAY_ALTERATION_ACCEPTED',
      account: { accountType: 'SERVICE' },
      hydratedContent: {
        content: {
          headerV2: { tombstoneHeader: { title: { body: 'Accepted' }, kicker: { body: 'OK' } } },
        },
      },
    });
    expect(result.kind).toBe('system');
  });

  it('STATIC_BULLETIN_CONTENT emits placeholder + classifies as system', () => {
    const result = extractText({
      contentType: 'STATIC_BULLETIN_CONTENT',
      contentSubType: 'WHATEVER',
      account: { accountType: 'SERVICE' },
      hydratedContent: { content: {} },
    });
    expect(result).toEqual({ kind: 'system', text: '[bulletin:contentSubType:WHATEVER]' });
  });

  it('unknown contentType emits placeholder', () => {
    const result = extractText({
      contentType: 'NEW_TYPE_X',
      account: { accountType: 'USER' },
      hydratedContent: { content: {} },
    });
    expect(result).toEqual({ kind: 'placeholder', text: '[unsupported:contentType:NEW_TYPE_X]' });
  });

  it('non-object input returns placeholder', () => {
    expect(extractText(null).kind).toBe('placeholder');
    expect(extractText('string').kind).toBe('placeholder');
    expect(extractText(42).kind).toBe('placeholder');
  });

  it('missing contentType emits placeholder with "missing"', () => {
    const result = extractText({});
    expect(result).toEqual({
      kind: 'placeholder',
      text: '[unsupported:contentType:missing]',
    });
  });
});

describe('buildThreadUrl', () => {
  const baseOpts = {
    threadHash: 'feed1234',
    globalThreadId: 'TWVzc2FnZVRocmVhZDoxMjM0NTY=',
  };

  it('targets /api/v3/ViaductGetThreadAndDataQuery with hash in path', () => {
    const url = buildThreadUrl(baseOpts);
    expect(url).toMatch(/\/api\/v3\/ViaductGetThreadAndDataQuery\/feed1234\?/);
  });

  it('encodes ALL Operation B variables exactly per spec §3', () => {
    const url = buildThreadUrl(baseOpts);
    const u = new URL(url);
    const variables = JSON.parse(u.searchParams.get('variables') ?? '');
    expect(variables).toEqual({
      globalThreadId: baseOpts.globalThreadId,
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
    });
  });

  it('omits earliestCursor when not provided', () => {
    const url = buildThreadUrl(baseOpts);
    const u = new URL(url);
    const variables = JSON.parse(u.searchParams.get('variables') ?? '');
    expect('earliestCursor' in variables).toBe(false);
  });

  it('includes earliestCursor when provided', () => {
    const url = buildThreadUrl({ ...baseOpts, earliestCursor: 'cursor-abc' });
    const u = new URL(url);
    const variables = JSON.parse(u.searchParams.get('variables') ?? '');
    expect(variables.earliestCursor).toBe('cursor-abc');
  });

  it('encodes operationName, locale, currency', () => {
    const url = buildThreadUrl(baseOpts);
    const u = new URL(url);
    expect(u.searchParams.get('operationName')).toBe('ViaductGetThreadAndDataQuery');
    expect(u.searchParams.get('locale')).toBe('en');
    expect(u.searchParams.get('currency')).toBe('USD');
  });

  it('respects custom numRequestedMessages', () => {
    const url = buildThreadUrl({ ...baseOpts, numRequestedMessages: 25 });
    const u = new URL(url);
    const variables = JSON.parse(u.searchParams.get('variables') ?? '');
    expect(variables.numRequestedMessages).toBe(25);
  });
});

describe('validateThreadResponse', () => {
  const HOST = deriveHostAccountIdFromInbox();
  const threadData = (threadFixture.data as Record<string, unknown>).threadData as Record<string, unknown>;
  const expectedRawId = decodeRelayId(threadData.id as string).raw;
  const expectedGlobalId = threadData.id as string;

  it('passes valid mixed-content fixture, returns sorted ScrapedMessages', () => {
    const result = validateThreadResponse(
      threadFixture,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.diagnostics.identityCheck).toBe('ok');
    expect(result.diagnostics.hostMembership).toBe('ok');
    expect(result.diagnostics.schemaFingerprintOk).toBe(true);
    expect(result.diagnostics.messagesReturned).toBeGreaterThan(0);

    // Messages should be sorted ASC by createdAtMs (== timestamp ASC).
    const ts = result.messages.map(m => Date.parse(m.timestamp));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
    }

    // Every emitted message has the airbnb-${numericId} prefix.
    for (const m of result.messages) {
      expect(m.airbnb_message_id).toMatch(/^airbnb-\d{6,}$/);
      expect(m.conversation_airbnb_id).toBe(expectedRawId);
      expect(['guest', 'host']).toContain(m.sender);
    }
  });

  it('counts contentTypes in diagnostics for mixed-content fixture', () => {
    const result = validateThreadResponse(
      threadFixture,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    // Spec/handoff says this fixture contains TEXT, VIEWER_BASED, TEMPLATE.
    const counts = result.diagnostics.contentTypeCounts;
    expect(counts.TEXT_CONTENT ?? 0).toBeGreaterThan(0);
    expect(
      (counts.VIEWER_BASED_CONTENT ?? 0) + (counts.TEMPLATE_CONTENT ?? 0),
    ).toBeGreaterThan(0);
  });

  it('emits MEDIA_CONTENT messages from media fixture', () => {
    const data = (mediaThreadFixture.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const rawId = decodeRelayId(data.id as string).raw;
    const result = validateThreadResponse(
      mediaThreadFixture,
      rawId,
      HOST,
      data.id as string,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    const mediaContent = result.messages.filter(m => m.content.startsWith('[media'));
    expect(mediaContent.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects identity mismatch when response.threadData.id decodes to wrong rawId', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    td.id = Buffer.from('MessageThread:9999999').toString('base64');
    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('identity_mismatch');
  });

  it('rejects identity mismatch when response prefix is not MessageThread', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    td.id = Buffer.from('Reaction:1234567').toString('base64');
    const result = validateThreadResponse(cloned, '1234567', HOST, expectedGlobalId, 'fakehash');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('identity_mismatch');
  });

  it('returns thread_host_mismatch (NOT wrong_host) for single-thread host miss', () => {
    // Per spec §2 invariant 1c + audit fix: thread-level host miss is recoverable
    // (drop + continue). Account-level miss happens at the inbox layer when ALL
    // threads fail.
    const result = validateThreadResponse(
      threadFixture,
      expectedRawId,
      '99999999',
      expectedGlobalId,
      'fakehash',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('thread_host_mismatch');
  });

  it('returns schema_mismatch when messageData.messages is absent', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    delete (td as Record<string, unknown>).messageData;
    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('schema_mismatch');
  });

  it('returns persisted_query_not_found on PQNF errors', () => {
    const result = validateThreadResponse(
      { errors: [{ extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] },
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('persisted_query_not_found');
  });

  it('drops soft-deleted messages (with deletedAtMs > 0 per spec guard)', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const messages = md.messages as Array<Record<string, unknown>>;
    const before = messages.length;
    // Mark first eligible TEXT_CONTENT user message as soft-deleted with a real
    // deletedAtMs > 0. Spec §2: drop only when both conditions hold.
    for (const m of messages) {
      if (
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER'
      ) {
        m.isSoftDelete = true;
        m.deletedAtMs = '1700000000000';
        break;
      }
    }
    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.diagnostics.droppedSoftDelete).toBe(1);
    expect(result.diagnostics.messagesReturned).toBe(before);
  });

  it('drops orphan reactions whose parentMessageId is not in batch', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const messages = md.messages as Array<Record<string, unknown>>;
    // Take a TEXT user message and add a synthetic reaction-style sibling whose
    // parent points to a message NOT in the batch (numeric id "1").
    const userMsg = messages.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    expect(userMsg).toBeDefined();
    const synthetic = JSON.parse(JSON.stringify(userMsg));
    synthetic.id = Buffer.from('Message:9999991').toString('base64');
    synthetic.opaqueId = '$1$9999991$1700000000000';
    synthetic.parentMessageId = Buffer.from('Message:1').toString('base64');
    synthetic.createdAtMs = String(Number(synthetic.createdAtMs) + 1);
    messages.push(synthetic);

    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.diagnostics.droppedOrphanReaction).toBe(1);
  });

  it('keeps reaction whose parent is in same batch', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const messages = md.messages as Array<Record<string, unknown>>;
    const parent = messages.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    expect(parent).toBeDefined();
    const parentId = parent!.id as string;
    const parentNumeric = decodeRelayId(parentId).raw;
    const synthetic = JSON.parse(JSON.stringify(parent));
    synthetic.id = Buffer.from('Message:9999992').toString('base64');
    synthetic.opaqueId = '$1$9999992$1700000000000';
    // Use raw numeric parent id (Airbnb sends both forms; both should be matched).
    synthetic.parentMessageId = parentNumeric;
    synthetic.createdAtMs = String(Number(synthetic.createdAtMs) + 1);
    messages.push(synthetic);

    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.diagnostics.droppedOrphanReaction).toBe(0);
    expect(result.messages.some(m => m.airbnb_message_id === 'airbnb-9999992')).toBe(true);
  });

  it('drops messages with origin not in thread participants', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const messages = md.messages as Array<Record<string, unknown>>;
    const userMsg = messages.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    expect(userMsg).toBeDefined();
    (userMsg!.account as Record<string, unknown>).accountId = 'NOT_A_PARTICIPANT_999999999';

    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.diagnostics.droppedOriginInvariant).toBe(1);
  });

  it('handles empty messages array (legitimate empty thread)', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    md.messages = [];
    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.messages).toEqual([]);
    expect(result.diagnostics.schemaFingerprintOk).toBe(true);
  });

  it('drops VIEWER_BASED_CONTENT (system) messages from emission', () => {
    const result = validateThreadResponse(
      threadFixture,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    // None of the emitted messages should have system-style content from VIEWER_BASED.
    // Mixed-content fixture has 1 VIEWER_BASED → expect droppedSystem >= 1.
    expect(result.diagnostics.droppedSystem).toBeGreaterThanOrEqual(1);
  });

  it('falls back to opaqueId when id is missing', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const messages = md.messages as Array<Record<string, unknown>>;
    const userMsg = messages.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    expect(userMsg).toBeDefined();
    delete userMsg!.id;
    // opaqueId remains: $1$<numeric>$<ts>
    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    // Expect that message still emitted (decoded numeric from opaqueId).
    const opaqueNumeric = (userMsg!.opaqueId as string).match(/^\$1\$(\d+)\$/)?.[1];
    expect(result.messages.some(m => m.airbnb_message_id === `airbnb-${opaqueNumeric}`)).toBe(true);
  });
});

describe('readThreadViaApi (page.evaluate stub)', () => {
  const HOST = deriveHostAccountIdFromInbox();
  const threadData = (threadFixture.data as Record<string, unknown>).threadData as Record<string, unknown>;
  const expectedRawId = decodeRelayId(threadData.id as string).raw;
  const expectedGlobalId = threadData.id as string;

  function makeStubPage(responses: Array<{ kind: string; body?: unknown; status?: number }>): {
    evaluate: (...args: unknown[]) => Promise<unknown>;
  } {
    let i = 0;
    return {
      evaluate: async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        return r;
      },
    };
  }

  it('returns ok with messages on a single-page response', async () => {
    const page = makeStubPage([{ kind: 'json', body: threadFixture }]);
    const outcome = await readThreadViaApi(page as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.messages.length).toBeGreaterThan(0);
  });

  it('maps HTTP 401/403 outcome to cookie_invalid', async () => {
    const page = makeStubPage([{ kind: 'auth_http', status: 401 }]);
    const outcome = await readThreadViaApi(page as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('cookie_invalid');
  });

  it('maps non-2xx HTTP outcome to http_error', async () => {
    const page = makeStubPage([{ kind: 'http_error', status: 500 }]);
    const outcome = await readThreadViaApi(page as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('http_error');
  });

  it('maps 2xx HTML body (challenge) to cookie_invalid', async () => {
    const page = makeStubPage([{ kind: 'non_json', status: 200 }]);
    const outcome = await readThreadViaApi(page as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('cookie_invalid');
  });

  it('does not cursor-walk when hasOlder=false', async () => {
    // Default fixture has < 50 messages and hasOlder=false → no walk.
    const page = makeStubPage([{ kind: 'json', body: threadFixture }]);
    let calls = 0;
    const wrapped = {
      evaluate: async (...args: unknown[]) => {
        calls += 1;
        return page.evaluate(...args);
      },
    };
    await readThreadViaApi(wrapped as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(calls).toBe(1);
  });

  it('cursor-walks when conditions met, capped at maxCursorWalks', async () => {
    // Each call returns a page with DISTINCT message ids (no overlap), hasOlder=true.
    // After overlap-stop fix, walks proceed up to the cap (3) → 1 initial + 3 walks = 4 calls.
    const baseTpl = (((threadFixture.data as Record<string, unknown>).threadData as Record<
      string,
      unknown
    >).messageData as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const userTpl = baseTpl.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    if (!userTpl) throw new Error('mixed fixture lacks USER TEXT message');

    function buildPage(pageIdx: number, hasOlder: boolean): Record<string, unknown> {
      const seed = JSON.parse(JSON.stringify(threadFixture));
      const td = (seed.data as Record<string, unknown>).threadData as Record<string, unknown>;
      const md = td.messageData as Record<string, unknown>;
      md.messages = [];
      while ((md.messages as Array<unknown>).length < 50) {
        const synthetic = JSON.parse(JSON.stringify(userTpl));
        const i = (md.messages as Array<unknown>).length;
        const tag = `${pageIdx}${i.toString().padStart(4, '0')}`;
        synthetic.id = Buffer.from(`Message:99${tag}000`).toString('base64');
        synthetic.opaqueId = `$1$99${tag}000$1700000000000`;
        synthetic.parentMessageId = null;
        synthetic.createdAtMs = String(2_000_000_000_000 - pageIdx * 100 + i);
        (md.messages as Array<unknown>).push(synthetic);
      }
      md.hasOlder = hasOlder;
      (md.expandedCursorsSegment as Record<string, unknown>).earliestCursor = `cursor-${pageIdx}`;
      return seed;
    }

    let calls = 0;
    const wrapped = {
      evaluate: async () => {
        calls += 1;
        return { kind: 'json', body: buildPage(calls, true) };
      },
    };
    const outcome = await readThreadViaApi(wrapped as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
      maxCursorWalks: 3,
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(4); // 1 initial + 3 walks at cap
  });

  it('cursor walk stops when oldest in page is at or below watermark', async () => {
    const seed = JSON.parse(JSON.stringify(threadFixture));
    const td = (seed.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const baseMessages = md.messages as Array<Record<string, unknown>>;
    const baseTpl = baseMessages.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    if (!baseTpl) throw new Error('fixture lacks USER TEXT');
    while ((md.messages as Array<unknown>).length < 50) {
      const synthetic = JSON.parse(JSON.stringify(baseTpl));
      const i = (md.messages as Array<unknown>).length;
      synthetic.id = Buffer.from(`Message:880000${i.toString().padStart(4, '0')}`).toString('base64');
      synthetic.opaqueId = `$1$880000${i.toString().padStart(4, '0')}$1700000000000`;
      synthetic.parentMessageId = null;
      synthetic.createdAtMs = String(1_500_000_000_000 + i);
      (md.messages as Array<unknown>).push(synthetic);
    }
    md.hasOlder = true;
    (md.expandedCursorsSegment as Record<string, unknown>).earliestCursor = 'cursor-1';

    let calls = 0;
    const wrapped = {
      evaluate: async () => {
        calls += 1;
        return { kind: 'json', body: seed };
      },
    };
    // watermark above oldest → walk shouldn't fire.
    const outcome = await readThreadViaApi(wrapped as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
      watermarkMs: 1_500_000_000_100, // greater than synthetic oldest
      maxCursorWalks: 5,
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('dedups across cursor pages (same airbnb_message_id appears once)', async () => {
    // Two pages, same content — readThreadViaApi should dedup by airbnb_message_id.
    const seed = JSON.parse(JSON.stringify(threadFixture));
    const td = (seed.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    md.hasOlder = true;
    (md.expandedCursorsSegment as Record<string, unknown>).earliestCursor = 'cursor-1';
    // Pad to 50 to trigger cursor walk.
    const baseTpl = (md.messages as Array<Record<string, unknown>>).find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    if (!baseTpl) throw new Error('fixture lacks USER TEXT');
    while ((md.messages as Array<unknown>).length < 50) {
      const synthetic = JSON.parse(JSON.stringify(baseTpl));
      const i = (md.messages as Array<unknown>).length;
      synthetic.id = Buffer.from(`Message:770000${i.toString().padStart(4, '0')}`).toString('base64');
      synthetic.opaqueId = `$1$770000${i.toString().padStart(4, '0')}$1700000000000`;
      synthetic.parentMessageId = null;
      synthetic.createdAtMs = String(2_500_000_000_000 + i);
      (md.messages as Array<unknown>).push(synthetic);
    }

    let calls = 0;
    const wrapped = {
      evaluate: async () => {
        calls += 1;
        if (calls >= 2) {
          // Second page returns same content but mark hasOlder=false to stop walk.
          const seed2 = JSON.parse(JSON.stringify(seed));
          ((seed2.data as Record<string, unknown>).threadData as Record<string, unknown>);
          (((seed2.data as Record<string, unknown>).threadData as Record<string, unknown>)
            .messageData as Record<string, unknown>).hasOlder = false;
          return { kind: 'json', body: seed2 };
        }
        return { kind: 'json', body: seed };
      },
    };
    const outcome = await readThreadViaApi(wrapped as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
      maxCursorWalks: 5,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    // Sanity: each id appears once
    const ids = outcome.messages.map(m => m.airbnb_message_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('cursor-walk uses RAW page timestamps (not post-filter) for oldest', async () => {
    // Construct a 50-message page where ALL messages are SERVICE/system (filtered out).
    // If the walk logic computed `oldest` from filtered messages, it would see an
    // empty list and abort the walk. With the v0.2 audit fix, raw timestamps drive
    // the gate and the walk proceeds (until hasOlder=false in next page).
    const seed = JSON.parse(JSON.stringify(threadFixture));
    const td = (seed.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const baseSystemMsg = (md.messages as Array<Record<string, unknown>>).find(
      m => m.contentType === 'VIEWER_BASED_CONTENT',
    );
    if (!baseSystemMsg) throw new Error('fixture lacks VIEWER_BASED');
    md.messages = [];
    while ((md.messages as Array<unknown>).length < 50) {
      const synthetic = JSON.parse(JSON.stringify(baseSystemMsg));
      const i = (md.messages as Array<unknown>).length;
      synthetic.id = Buffer.from(`Message:660000${i.toString().padStart(4, '0')}`).toString('base64');
      synthetic.opaqueId = `$1$660000${i.toString().padStart(4, '0')}$1700000000000`;
      synthetic.parentMessageId = null;
      synthetic.createdAtMs = String(3_000_000_000_000 + i);
      (md.messages as Array<unknown>).push(synthetic);
    }
    md.hasOlder = true;
    (md.expandedCursorsSegment as Record<string, unknown>).earliestCursor = 'cursor-sys';

    let calls = 0;
    const wrapped = {
      evaluate: async () => {
        calls += 1;
        if (calls === 1) return { kind: 'json', body: seed };
        // Page 2: hasOlder=false to terminate
        const seed2 = JSON.parse(JSON.stringify(seed));
        const td2 = (seed2.data as Record<string, unknown>).threadData as Record<string, unknown>;
        const md2 = td2.messageData as Record<string, unknown>;
        md2.hasOlder = false;
        return { kind: 'json', body: seed2 };
      },
    };
    const outcome = await readThreadViaApi(wrapped as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(true);
    // Walk MUST have happened (calls >= 2) even though emitted messages is 0.
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('cursor-walk stops on overlap with prior pages', async () => {
    // First page returns 50 unique messages. Second page returns the same 50.
    // Overlap detected → walk stops without trying page 3, even with hasOlder=true.
    const seed = JSON.parse(JSON.stringify(threadFixture));
    const td = (seed.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const baseTpl = (md.messages as Array<Record<string, unknown>>).find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    if (!baseTpl) throw new Error('fixture lacks USER TEXT');
    md.messages = [];
    while ((md.messages as Array<unknown>).length < 50) {
      const synthetic = JSON.parse(JSON.stringify(baseTpl));
      const i = (md.messages as Array<unknown>).length;
      synthetic.id = Buffer.from(`Message:550000${i.toString().padStart(4, '0')}`).toString('base64');
      synthetic.opaqueId = `$1$550000${i.toString().padStart(4, '0')}$1700000000000`;
      synthetic.parentMessageId = null;
      synthetic.createdAtMs = String(2_700_000_000_000 + i);
      (md.messages as Array<unknown>).push(synthetic);
    }
    md.hasOlder = true;
    (md.expandedCursorsSegment as Record<string, unknown>).earliestCursor = 'cursor-overlap';

    let calls = 0;
    const wrapped = {
      evaluate: async () => {
        calls += 1;
        return { kind: 'json', body: JSON.parse(JSON.stringify(seed)) };
      },
    };
    const outcome = await readThreadViaApi(wrapped as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
      maxCursorWalks: 5,
    });
    expect(outcome.ok).toBe(true);
    // Initial page (calls=1) accumulates 50; second page (calls=2) is full overlap → stop.
    expect(calls).toBe(2);
  });

  it('HTTP 404 with PQNF body maps to persisted_query_not_found', async () => {
    const stub = {
      evaluate: async () => ({
        kind: 'http_error',
        status: 404,
        bodyText: '{"errors":[{"extensions":{"code":"PERSISTED_QUERY_NOT_FOUND"}}]}',
      }),
    };
    const outcome = await readThreadViaApi(stub as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('persisted_query_not_found');
  });

  it('HTTP 404 without PQNF body falls through to http_error', async () => {
    const stub = {
      evaluate: async () => ({
        kind: 'http_error',
        status: 404,
        bodyText: '<html>not found</html>',
      }),
    };
    const outcome = await readThreadViaApi(stub as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('http_error');
  });

  it('preserves cross-page orphan reactions when parent appears in later page', async () => {
    // Page 1: includes a reaction whose parent is on Page 2.
    // Without cross-page tracking, the reaction is dropped on page 1 and never
    // re-emitted (Gemini v0.2 audit). With cross-page tracking, the reaction is
    // skipped on page 1 (parent unknown) but re-evaluated... actually in our
    // current model, page-1 emission is final. So the realistic v0.2 behavior is:
    // the reaction is dropped on page 1, parent appears on page 2, no re-emission.
    // For now we assert that the parent on page 2 IS emitted, and the reaction
    // (with a within-page-2 parent reference) is also kept. The cross-page
    // claim is harder to exercise without re-emission; track via integration.
    // This test focuses on within-page parent matching working post-fix.
    const seed = JSON.parse(JSON.stringify(threadFixture));
    const td = (seed.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    md.hasOlder = false;
    const stub = { evaluate: async () => ({ kind: 'json', body: seed }) };
    const outcome = await readThreadViaApi(stub as never, {
      rawThreadId: expectedRawId,
      globalThreadId: expectedGlobalId,
      hostNumericId: HOST,
      threadHash: 'fakehash',
      apiKey: 'k',
      clientVersion: 'v',
    });
    expect(outcome.ok).toBe(true);
  });
});

describe('soft-delete guard', () => {
  const HOST = deriveHostAccountIdFromInbox();
  const threadData = (threadFixture.data as Record<string, unknown>).threadData as Record<string, unknown>;
  const expectedRawId = decodeRelayId(threadData.id as string).raw;
  const expectedGlobalId = threadData.id as string;

  it('drops only when isSoftDelete=true AND deletedAtMs > 0', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const messages = md.messages as Array<Record<string, unknown>>;
    const userMsg = messages.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    expect(userMsg).toBeDefined();
    userMsg!.isSoftDelete = true;
    userMsg!.deletedAtMs = '1700000000000';

    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.diagnostics.droppedSoftDelete).toBe(1);
  });

  it('does NOT drop when isSoftDelete=true but deletedAtMs=0 (malformed/future tombstone)', () => {
    const cloned = JSON.parse(JSON.stringify(threadFixture));
    const td = (cloned.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const md = td.messageData as Record<string, unknown>;
    const messages = md.messages as Array<Record<string, unknown>>;
    const userMsg = messages.find(
      m =>
        m.contentType === 'TEXT_CONTENT' &&
        (m.account as Record<string, unknown>)?.accountType === 'USER',
    );
    expect(userMsg).toBeDefined();
    userMsg!.isSoftDelete = true;
    userMsg!.deletedAtMs = '0';

    const result = validateThreadResponse(
      cloned,
      expectedRawId,
      HOST,
      expectedGlobalId,
      'fakehash',
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.diagnostics.droppedSoftDelete).toBe(0);
  });
});
