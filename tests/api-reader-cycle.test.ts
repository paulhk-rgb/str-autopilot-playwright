import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';

import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  currentAuthEpoch,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';
import { runApiReaderCycle } from '../src/playwright/api-reader-cycle';
import { SpaListener } from '../src/playwright/spa-listener';
import { WatermarkStore } from '../src/playwright/watermark-store';
import { decodeRelayId } from '../src/playwright/api-reader';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'api-reader');
const inboxFixture = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'inbox-15-threads-mixed.json'), 'utf8'),
) as Record<string, unknown>;
const threadFixture = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'thread-with-mixed-content.json'), 'utf8'),
) as Record<string, unknown>;

function deriveHostAccountId(inbox: Record<string, unknown>): string {
  const data = inbox.data as Record<string, unknown>;
  const node = data.node as Record<string, unknown>;
  const messagingInbox = node.messagingInbox as Record<string, unknown>;
  const inboxItems = messagingInbox.inboxItems as Record<string, unknown>;
  const edges = inboxItems.edges as Array<Record<string, unknown>>;
  let common: Set<string> | null = null;
  for (const edge of edges) {
    const tn = edge.node as Record<string, unknown>;
    const participants = tn.participants as Record<string, unknown>;
    const partEdges = participants.edges as Array<Record<string, unknown>>;
    const ids = new Set<string>();
    for (const pe of partEdges) {
      const peNode = pe.node as Record<string, unknown>;
      if (typeof peNode.accountId === 'string') ids.add(peNode.accountId);
    }
    common = common === null ? ids : new Set([...common].filter(x => ids.has(x)));
  }
  if (!common || common.size !== 1) throw new Error('expected one common host accountId');
  return [...common][0];
}

const HOST = deriveHostAccountId(inboxFixture);

function makePage(handler: (callIdx: number) => unknown): {
  page: { evaluate: (...args: unknown[]) => Promise<unknown> };
  callCount: () => number;
} {
  let calls = 0;
  return {
    page: {
      evaluate: async () => {
        calls += 1;
        return handler(calls);
      },
    },
    callCount: () => calls,
  };
}

function makeReadyListener(): SpaListener {
  const l = new SpaListener();
  l._injectForTesting({
    inboxHash: 'aaa',
    threadHash: 'bbb',
    clientVersion: 'ccc',
    lastObservedAtMs: Date.now(),
  });
  return l;
}

describe('runApiReaderCycle', () => {
  let dir: string;
  let store: WatermarkStore;

  beforeEach(() => {
    _resetAuthEpochForTesting();
    dir = mkdtempSync(join(tmpdir(), 'cycle-'));
    store = new WatermarkStore(join(dir, 'watermarks.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns auth_epoch_not_ready when authEpoch.ready=false', async () => {
    const { page, callCount } = makePage(() => ({ kind: 'json', body: inboxFixture }));
    const out = await runApiReaderCycle(page as never, {
      mode: 'shadow',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa: makeReadyListener(),
    });
    expect(out.ok).toBe(false);
    expect(out.apiSkipReason).toBe('auth_epoch_not_ready');
    expect(callCount()).toBe(0); // no fetch attempted
  });

  it('returns no_spa_observation when SPA listener has no clientVersion', async () => {
    markAuthEpochReady();
    const spa = new SpaListener(); // no observations injected
    const { page, callCount } = makePage(() => ({ kind: 'json', body: inboxFixture }));
    const out = await runApiReaderCycle(page as never, {
      mode: 'shadow',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa,
    });
    expect(out.ok).toBe(false);
    expect(out.apiSkipReason).toBe('no_spa_observation');
    expect(callCount()).toBe(0);
  });

  it('returns inbox_failed when listInboxViaApi maps to cookie_invalid', async () => {
    markAuthEpochReady();
    const { page } = makePage(() => ({
      kind: 'json',
      body: { errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] },
    }));
    const out = await runApiReaderCycle(page as never, {
      mode: 'api',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa: makeReadyListener(),
    });
    expect(out.ok).toBe(false);
    expect(out.apiSkipReason).toBe('inbox_failed');
    expect(out.inboxFailureReason).toBe('cookie_invalid');
  });

  it('aborts mid-cycle when authEpoch changes (auth_epoch_changed)', async () => {
    markAuthEpochReady();
    let firstCall = true;
    const { page } = makePage(() => {
      if (firstCall) {
        firstCall = false;
        return { kind: 'json', body: inboxFixture };
      }
      // Simulate cookie rotation between inbox call and first thread fetch.
      beginCookieInject();
      return { kind: 'json', body: threadFixture };
    });
    const out = await runApiReaderCycle(page as never, {
      mode: 'api',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa: makeReadyListener(),
      // Skip jitter to keep the test fast.
      interThreadJitterMs: { minMs: 0, maxMs: 0 },
    });
    expect(out.ok).toBe(false);
    expect(out.authEpochAborted).toBe(true);
    expect(out.apiSkipReason).toBe('auth_epoch_changed');
  });

  it('shadow mode without comparator surfaces uiBatchTimedOut diagnostic', async () => {
    markAuthEpochReady();
    // Inbox returns full fixture (15 threads). Per-thread fetches all return the
    // same threadFixture (will fail identity check for 14 of 15 — but the 1st
    // thread's globalThreadId matches threadFixture, so 1 thread emits messages).
    const { page } = makePage(callIdx => {
      if (callIdx === 1) return { kind: 'json', body: inboxFixture };
      // For every per-thread call, return threadFixture body.
      return { kind: 'json', body: threadFixture };
    });
    const out = await runApiReaderCycle(page as never, {
      mode: 'shadow',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa: makeReadyListener(),
      interThreadJitterMs: { minMs: 0, maxMs: 0 },
    });
    expect(out.ok).toBe(true);
    expect(out.shadow).toBeDefined();
    expect(out.shadow?.uiBatchTimedOut).toBe(true);
    expect(out.shadow?.onlyInApi.length).toBeGreaterThanOrEqual(0);
  });

  it('shadow mode WITH comparator persists watermark advances on successful intersection', async () => {
    markAuthEpochReady();
    // Single matching thread — first inbox edge's globalThreadId becomes the
    // thread's globalThreadId, so identity invariant holds.
    const td = (threadFixture.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const matchingGlobalId = td.id as string;
    const matchingRawId = decodeRelayId(matchingGlobalId).raw;

    // Stub inbox: only 1 thread, with globalThreadId = matchingGlobalId, host in participants.
    const oneThreadInbox = {
      data: {
        node: {
          messagingInbox: {
            inboxItems: {
              edges: [
                {
                  node: {
                    id: matchingGlobalId,
                    participants: {
                      edges: [{ node: { accountId: HOST } }],
                    },
                  },
                },
              ],
              pageInfo: {},
            },
          },
        },
      },
    };

    const { page } = makePage(callIdx => {
      if (callIdx === 1) return { kind: 'json', body: oneThreadInbox };
      return { kind: 'json', body: threadFixture };
    });

    const compare = vi.fn().mockResolvedValue({
      advance: { [matchingRawId]: 1_700_000_000_000 },
      diagnostic: {
        cycleId: 'x',
        uiBatchTimedOut: false,
        uiToApiIdMatches: 5,
        uiToApiIdMismatches: 0,
        onlyInUi: [],
        onlyInApi: [],
      },
    });

    const out = await runApiReaderCycle(page as never, {
      mode: 'shadow',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa: makeReadyListener(),
      interThreadJitterMs: { minMs: 0, maxMs: 0 },
      shadowCompare: compare,
    });
    expect(out.ok).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(out.watermarkAdvancesApplied[matchingRawId]).toBe(1_700_000_000_000);
    expect(out.shadow?.uiBatchTimedOut).toBe(false);
    // Persistence: file written.
    expect(store.load()[matchingRawId]).toBe(1_700_000_000_000);
  });

  it('api mode proposes per-thread watermark advances based on emitted message timestamps', async () => {
    markAuthEpochReady();
    const td = (threadFixture.data as Record<string, unknown>).threadData as Record<string, unknown>;
    const matchingGlobalId = td.id as string;
    const matchingRawId = decodeRelayId(matchingGlobalId).raw;
    const oneThreadInbox = {
      data: {
        node: {
          messagingInbox: {
            inboxItems: {
              edges: [
                {
                  node: {
                    id: matchingGlobalId,
                    participants: { edges: [{ node: { accountId: HOST } }] },
                  },
                },
              ],
              pageInfo: {},
            },
          },
        },
      },
    };
    const { page } = makePage(callIdx =>
      callIdx === 1
        ? { kind: 'json', body: oneThreadInbox }
        : { kind: 'json', body: threadFixture },
    );

    const out = await runApiReaderCycle(page as never, {
      mode: 'api',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa: makeReadyListener(),
      interThreadJitterMs: { minMs: 0, maxMs: 0 },
    });
    expect(out.ok).toBe(true);
    expect(out.totalApiMessagesEmitted).toBeGreaterThan(0);
    expect(out.watermarkAdvancesApplied[matchingRawId]).toBeGreaterThan(0);
  });

  it('elapsedMs is populated and start/end auth-epoch recorded', async () => {
    markAuthEpochReady();
    const startEpoch = currentAuthEpoch();
    const { page } = makePage(() => ({
      kind: 'json',
      body: { data: { node: { messagingInbox: { inboxItems: { edges: [], pageInfo: {} } } } } },
    }));
    const out = await runApiReaderCycle(page as never, {
      mode: 'api',
      hostNumericId: HOST,
      globalUserId: 'g',
      apiKey: 'k',
      inboxHashFallback: 'aaa',
      threadHashFallback: 'bbb',
      watermarkStore: store,
      spa: makeReadyListener(),
    });
    expect(out.ok).toBe(true);
    expect(out.cycleStartAuthEpoch).toBe(startEpoch);
    expect(out.cycleEndAuthEpoch).toBe(startEpoch);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
