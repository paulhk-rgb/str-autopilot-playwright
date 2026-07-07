import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import { scrapeInbox } from '../src/playwright/scrape-inbox';

/**
 * DOM-leg card/system classification (spec v1.17). Drives the REAL readThread
 * page.evaluate callback in-process via a fake Page whose evaluate() invokes
 * the function directly against a stubbed globalThis.document — same shipped
 * code path, no browser.
 */

type FakeEl = {
  getAttribute(n: string): string | null;
  querySelector(sel: string): { textContent: string | null } | null;
};

function group(aria: string): FakeEl {
  return {
    getAttribute: (n) => (n === 'aria-label' ? aria : null),
    querySelector: () => ({ textContent: 'Today' }),
  };
}

function fakeContextFor(groups: FakeEl[]): BrowserContext {
  const fakeDoc = {
    querySelectorAll: (sel: string) =>
      sel === '[data-testid="message-list"] > div[role="group"]' ? groups : [],
  };
  const fakePage = {
    goto: async () => null,
    url: () => 'https://www.airbnb.com/hosting/messages/123456',
    waitForSelector: async () => ({}),
    evaluate: async (fn: (limit: number) => unknown, arg: number) => {
      const g = globalThis as unknown as { document?: unknown };
      const prev = g.document;
      g.document = fakeDoc;
      try {
        return fn(arg);
      } finally {
        if (prev === undefined) delete g.document;
        else g.document = prev;
      }
    },
    close: async () => undefined,
  };
  return { newPage: async () => fakePage } as unknown as BrowserContext;
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

describe('scrapeInbox DOM leg — card artifact classification (spec v1.17)', () => {
  it('drops card fallback strings instead of emitting them as guest/host', async () => {
    const ctx = fakeContextFor([
      group('Veronica Fixture sent Hello there. Sent 2 hours ago.'),
      group('Veronica Fixture sent message but description not available. Sent 2 hours ago.'),
      group('Host Fixture sent message but description not available. Sent 2 hours ago.'),
      group('Veronica Fixture sent Suggestion: Change reservation. Sent 2 hours ago.'),
      group('Airbnb service says Reservation confirmed. Sent 1 hour ago.'),
    ]);
    const result = await scrapeInbox(ctx, {
      mode: 'incremental',
      hostDisplayName: 'Host Fixture',
      targetThreadIds: ['123456'],
    });

    expect(result.errors).toEqual([]);
    // Only the real guest message survives; both fallback-string card rows
    // (the both-senders dup class), the suggestion card, and the service row
    // are classified system and dropped.
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].content).toBe('Hello there');
    expect(result.messages[0].sender).toBe('guest');
  });

  it('does not swallow real guest text that merely CONTAINS an artifact phrase', async () => {
    const ctx = fakeContextFor([
      group(
        'Veronica Fixture sent I got a message but description not available on my end, resend?. Sent 2 hours ago.',
      ),
      group('Veronica Fixture sent Suggestion: change reservation to Friday please. Sent 1 hour ago.'),
    ]);
    const result = await scrapeInbox(ctx, {
      mode: 'incremental',
      hostDisplayName: 'Host Fixture',
      targetThreadIds: ['123456'],
    });

    expect(result.errors).toEqual([]);
    // Exact-match list only — neither line equals an artifact string exactly.
    expect(result.messages.length).toBe(2);
    for (const m of result.messages) {
      expect(m.sender).toBe('guest');
    }
  });
});
