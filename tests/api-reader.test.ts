import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALLOWED_THREAD_PREFIXES,
  buildApolloHeaders,
  buildInboxUrl,
  decodeRelayId,
  generateTraceId,
  validateInboxResponse,
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
