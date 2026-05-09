import { describe, expect, it } from 'vitest';

import { __scrapeInboxTestHooks } from '../src/playwright/scrape-inbox';

const {
  extractConcreteMessagesUrlFromCookieValue,
  hasReachedMessagesTarget,
  isExplicitEmptyInboxText,
  listInboxThreads,
  parseInboxThreadSummary,
  readThread,
} =
  __scrapeInboxTestHooks;

type FakeElement = {
  getAttribute: (name: string) => string | null;
  textContent: string | null;
  innerText?: string;
};

type FakePageState = {
  rows?: Array<{ id: string; text: string }>;
  loaderPresent?: boolean;
  messageListPresent?: boolean;
  bodyText?: string;
  sidebarText?: string;
};

function makeElement(testId: string, text: string): FakeElement {
  return {
    getAttribute: (name: string) => (name === 'data-testid' ? testId : null),
    textContent: text,
    innerText: text,
  };
}

function makeFakeInboxPage(input: {
  rows?: Array<{ id: string; text: string }>;
  loaderPresent?: boolean;
  bodyText?: string;
  sidebarText?: string;
  cookies?: Array<{ name: string; value: string }>;
  statesByUrl?: Record<string, FakePageState>;
  gotoError?: Error;
  url?: string;
}) {
  let currentUrl = input.url ?? 'https://www.airbnb.com/hosting/messages';
  const gotos: string[] = [];

  const currentState = (): FakePageState => {
    return input.statesByUrl?.[currentUrl] ?? input;
  };

  const rowElements = (): FakeElement[] =>
    (currentState().rows ?? []).map((row) => makeElement(`inbox_list_${row.id}`, row.text));

  const sidebarElement = (): FakeElement[] =>
    currentState().sidebarText !== undefined
      ? [makeElement('inbox-container-marker', currentState().sidebarText ?? '')]
      : [];

  const testIdElements = (): FakeElement[] => [
    ...(currentState().loaderPresent ? [makeElement('inbox-list-loader', '')] : []),
    ...sidebarElement(),
    ...rowElements(),
  ];

  const doc = {
    title: 'Messages • Airbnb',
    body: {
      get innerText() {
        return currentState().bodyText ?? 'Messages';
      },
    },
    querySelector: (selector: string) => {
      if (selector === '[data-testid="inbox-list-loader"]' && currentState().loaderPresent) {
        return makeElement('inbox-list-loader', '');
      }
      if (selector === '[data-testid="message-list"]' && currentState().messageListPresent) {
        return makeElement('message-list', '');
      }
      if (selector === '[data-testid="inbox-container-marker"]') {
        return sidebarElement()[0] ?? null;
      }
      if (selector === '[data-testid="orbital-panel-inbox"]') {
        return sidebarElement()[0] ?? null;
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'a[data-testid^="inbox_list_"]') return rowElements();
      if (selector === '[data-testid]') return testIdElements();
      if (selector === 'a') return rowElements();
      return [];
    },
  };
  const page = {
    reloads: 0,
    gotos,
    context: () => ({
      cookies: async () => input.cookies ?? [],
    }),
    goto: async (url: string) => {
      gotos.push(url);
      if (input.gotoError) throw input.gotoError;
      currentUrl = url;
    },
    url: () => currentUrl,
    reload: async () => {
      page.reloads += 1;
    },
    waitForFunction: async <T, Args extends unknown[]>(fn: (...args: Args) => T, arg: Args[0]) => {
      await page.evaluate(fn, arg);
    },
    waitForTimeout: async () => undefined,
    evaluate: async <T, Args extends unknown[]>(fn: (...args: Args) => T, ...args: Args) => {
      const prevDocument = (globalThis as unknown as { document?: unknown }).document;
      const prevLocation = (globalThis as unknown as { location?: unknown }).location;
      (globalThis as unknown as { document?: unknown }).document = doc;
      (globalThis as unknown as { location?: unknown }).location = {
        href: page.url(),
      };
      try {
        return fn(...args);
      } finally {
        (globalThis as unknown as { document?: unknown }).document = prevDocument;
        (globalThis as unknown as { location?: unknown }).location = prevLocation;
      }
    },
  };
  return page;
}

function evaluateWithDocument<T, Args extends unknown[]>(
  doc: unknown,
  fn: (...args: Args) => T,
  args: Args,
): T {
  const prevDocument = (globalThis as unknown as { document?: unknown }).document;
  (globalThis as unknown as { document?: unknown }).document = doc;
  try {
    return fn(...args);
  } finally {
    (globalThis as unknown as { document?: unknown }).document = prevDocument;
  }
}

describe('scrape-inbox sidebar metadata parser', () => {
  const now = new Date('2026-05-09T12:00:00.000Z');

  it('extracts guest, same-month dates, and listing from an inbox row', () => {
    const parsed = parseInboxThreadSummary(
      '2470285483',
      [
        'Stuart',
        '7:48 AM',
        'Hi Paul, you had mentioned that I...',
        'Confirmed · May 7 – 10 · One Bedroom Private Unit .3 Miles from Commons',
      ].join('\n'),
      now,
    );

    expect(parsed).toEqual({
      threadId: '2470285483',
      guestName: 'Stuart',
      checkIn: '2026-05-07',
      checkOut: '2026-05-10',
      stayText: 'May 7 – 10',
      listingName: 'One Bedroom Private Unit .3 Miles from Commons',
    });
  });

  it('handles Airbnb thin spaces around the date-range dash', () => {
    const parsed = parseInboxThreadSummary(
      '2470285483',
      [
        'Stuart',
        'Currently hosting · May 7 – 10 · One Bedroom Private Unit .3 Miles from Commons',
      ].join('\n'),
      now,
    );

    expect(parsed.checkIn).toBe('2026-05-07');
    expect(parsed.checkOut).toBe('2026-05-10');
    expect(parsed.stayText).toBe('May 7 – 10');
  });

  it('continues after a goto timeout when Airbnb has already rendered messages', async () => {
    const page = makeFakeInboxPage({
      gotoError: new Error('page.goto: Timeout 30000ms exceeded'),
      url: 'https://www.airbnb.com/hosting/messages/2470285483',
      rows: [
        {
          id: '2470285483',
          text: [
            'Stuart',
            'Currently hosting · May 7, 2026 – May 10, 2026 · One Bedroom Private Unit .3 Miles from Commons',
          ].join('\n'),
        },
      ],
    });

    await expect(listInboxThreads(page as never, 10)).resolves.toMatchObject([
      {
        threadId: '2470285483',
        guestName: 'Stuart',
        checkIn: '2026-05-07',
        checkOut: '2026-05-10',
      },
    ]);
  });

  it('propagates non-timeout navigation errors even from a messages URL', async () => {
    const page = makeFakeInboxPage({
      gotoError: new Error('net::ERR_INTERNET_DISCONNECTED'),
      url: 'https://www.airbnb.com/hosting/messages/2470285483',
    });

    await expect(listInboxThreads(page as never, 10)).rejects.toThrow(
      /ERR_INTERNET_DISCONNECTED/,
    );
  });

  it('continues reading a thread after a navigation timeout when messages rendered', async () => {
    const threadUrl = 'https://www.airbnb.com/hosting/messages/2470285483';
    const group = {
      getAttribute: (name: string) =>
        name === 'aria-label'
          ? 'Stuart sent Thanks again. Sent Today at 9:00 AM.'
          : null,
      querySelector: (selector: string) =>
        selector === 'h2' ? { textContent: 'Today' } : null,
    };
    const doc = {
      querySelectorAll: (selector: string) =>
        selector === '[data-testid="message-list"] > div[role="group"]' ? [group] : [],
    };
    const page = {
      goto: async () => {
        throw new Error('page.goto: Timeout 12000ms exceeded');
      },
      url: () => threadUrl,
      waitForSelector: async () => undefined,
      reload: async () => {
        throw new Error('reload should not be needed');
      },
      evaluate: async <T, Args extends unknown[]>(fn: (...args: Args) => T, ...args: Args) =>
        evaluateWithDocument(doc, fn, args),
    };

    await expect(readThread(page as never, '2470285483', 20)).resolves.toMatchObject([
      {
        senderName: 'Stuart',
        text: 'Thanks again',
        timestamp: 'Today at 9:00 AM',
        dateHeading: 'Today',
      },
    ]);
  });

  it('does not tolerate a thread timeout that leaves the page on a different thread', async () => {
    const staleThreadUrl = 'https://www.airbnb.com/hosting/messages/2462778940';
    const page = {
      goto: async () => {
        throw new Error('page.goto: Timeout 10000ms exceeded');
      },
      url: () => staleThreadUrl,
      waitForSelector: async () => {
        throw new Error('stale message list must not be inspected');
      },
      evaluate: async () => {
        throw new Error('stale message list must not be parsed');
      },
    };

    await expect(readThread(page as never, '2470285483', 20)).rejects.toThrow(
      /Timeout 10000ms exceeded/,
    );
  });

  it('allows query strings when checking whether a timed-out thread reached its target', () => {
    expect(
      hasReachedMessagesTarget(
        'https://www.airbnb.com/hosting/messages/2470285483/?locale=en',
        'https://www.airbnb.com/hosting/messages/2470285483',
        'thread',
      ),
    ).toBe(true);
    expect(
      hasReachedMessagesTarget(
        'https://www.airbnb.com/hosting/messages/2462778940?locale=en',
        'https://www.airbnb.com/hosting/messages/2470285483',
        'thread',
      ),
    ).toBe(false);
    expect(
      hasReachedMessagesTarget(
        'https://www.airbnb.ca/hosting/messages/2470285483?locale=en-CA',
        'https://www.airbnb.com/hosting/messages/2470285483',
        'thread',
      ),
    ).toBe(true);
    expect(
      hasReachedMessagesTarget(
        'https://evil.example/hosting/messages/2470285483',
        'https://www.airbnb.com/hosting/messages/2470285483',
        'thread',
      ),
    ).toBe(false);
  });

  it('fails closed when a thread page never renders a message list', async () => {
    let reloadCalled = false;
    const page = {
      goto: async () => undefined,
      url: () => 'https://www.airbnb.com/hosting/messages/2470285483',
      waitForSelector: async () => {
        throw new Error('selector timeout');
      },
      reload: async () => {
        reloadCalled = true;
      },
      evaluate: async () => [],
    };

    await expect(readThread(page as never, '2470285483', 20)).rejects.toThrow(
      /thread_message_list_unavailable/,
    );
    expect(reloadCalled).toBe(false);
  });

  it('handles cross-month stays and strips action/status noise', () => {
    const parsed = parseInboxThreadSummary(
      '2503263138',
      [
        'Olga',
        'You: Thanks so much for staying w...',
        'Apr 15 – May 6 · One Bedroom Private Unit .3 Miles from Commons',
        'Leave a review',
      ].join('\n'),
      now,
    );

    expect(parsed.guestName).toBe('Olga');
    expect(parsed.checkIn).toBe('2026-04-15');
    expect(parsed.checkOut).toBe('2026-05-06');
    expect(parsed.listingName).toBe('One Bedroom Private Unit .3 Miles from Commons');
  });

  it('keeps dates unset when an undated row would otherwise be ambiguous', () => {
    const parsed = parseInboxThreadSummary(
      'older-thread',
      'Jenny\nNov 28 – Dec 2 · 2 Bedroom .3 miles from commons',
      now,
    );

    expect(parsed.stayText).toBe('Nov 28 – Dec 2');
    expect(parsed.listingName).toBe('2 Bedroom .3 miles from commons');
    expect(parsed.checkIn).toBeUndefined();
    expect(parsed.checkOut).toBeUndefined();
  });

  it('parses explicit cross-year ranges with the year attached to checkout', () => {
    const parsed = parseInboxThreadSummary(
      'cross-year-thread',
      'Pat\nDec 30 - Jan 2, 2024 · Lake House',
      now,
    );

    expect(parsed.checkIn).toBe('2023-12-30');
    expect(parsed.checkOut).toBe('2024-01-02');
  });

  it('infers next year for near-future January stays scraped in December', () => {
    const parsed = parseInboxThreadSummary(
      'new-year-thread',
      'Riley\nJan 2 - 5 · Lake House',
      new Date('2026-12-30T12:00:00.000Z'),
    );

    expect(parsed.checkIn).toBe('2027-01-02');
    expect(parsed.checkOut).toBe('2027-01-05');
  });

  it('parses dual-year ranges', () => {
    const parsed = parseInboxThreadSummary(
      'dual-year-thread',
      'Dana\nDec 30, 2023 - Jan 2, 2024 · Lake House',
      now,
    );

    expect(parsed.checkIn).toBe('2023-12-30');
    expect(parsed.checkOut).toBe('2024-01-02');
  });

  it('does not emit invalid ISO date strings', () => {
    const parsed = parseInboxThreadSummary(
      'invalid-date-thread',
      'Inquiry\nFeb 31 - Mar 2 · Lake House',
      now,
    );

    expect(parsed.guestName).toBeUndefined();
    expect(parsed.stayText).toBe('Feb 31 - Mar 2');
    expect(parsed.checkIn).toBeUndefined();
    expect(parsed.checkOut).toBeUndefined();
  });

  it('recognizes only explicit empty inbox copy as a no-op', () => {
    expect(isExplicitEmptyInboxText('No messages yet')).toBe(true);
    expect(isExplicitEmptyInboxText("You don't have any messages yet")).toBe(true);
    expect(isExplicitEmptyInboxText('Messages')).toBe(false);
    expect(isExplicitEmptyInboxText("Sorry, there's nothing here")).toBe(false);
  });

  it('extracts only safe concrete Airbnb message thread URLs from cookies', () => {
    expect(
      extractConcreteMessagesUrlFromCookieValue(
        encodeURIComponent('https://www.airbnb.com/hosting/messages/2470285483?filter=unread#top'),
      ),
    ).toBe('https://www.airbnb.com/hosting/messages/2470285483');
    expect(extractConcreteMessagesUrlFromCookieValue('/hosting/messages/2470285483')).toBe(
      'https://www.airbnb.com/hosting/messages/2470285483',
    );

    expect(extractConcreteMessagesUrlFromCookieValue('/hosting/messages')).toBeNull();
    expect(extractConcreteMessagesUrlFromCookieValue('https://evil.com/hosting/messages/1')).toBeNull();
    expect(extractConcreteMessagesUrlFromCookieValue('/hosting/messages/abc')).toBeNull();
    expect(extractConcreteMessagesUrlFromCookieValue('invalid%cookie')).toBeNull();
  });

  it('fails closed when Airbnb leaves the inbox sidebar unloaded', async () => {
    const page = makeFakeInboxPage({
      loaderPresent: true,
      bodyText: 'Messages',
    });

    await expect(listInboxThreads(page as never, 10)).rejects.toThrow(
      /inbox_list_unavailable/,
    );
    expect(page.reloads).toBe(1);
  });

  it('uses the last known thread URL when the bare inbox shell never renders rows', async () => {
    const fallbackUrl = 'https://www.airbnb.com/hosting/messages/2470285483';
    const page = makeFakeInboxPage({
      cookies: [
        {
          name: '__ps_lu',
          value: encodeURIComponent(`${fallbackUrl}?filter=unread`),
        },
      ],
      statesByUrl: {
        'https://www.airbnb.com/hosting/messages': {
          loaderPresent: true,
          bodyText: 'Messages',
        },
        [fallbackUrl]: {
          rows: [
            {
              id: '2470285483',
              text: [
                'Stuart',
                'Currently hosting · May 7, 2026 – May 10, 2026 · One Bedroom Private Unit .3 Miles from Commons',
              ].join('\n'),
            },
          ],
        },
      },
    });

    await expect(listInboxThreads(page as never, 10)).resolves.toMatchObject([
      {
        threadId: '2470285483',
        guestName: 'Stuart',
        checkIn: '2026-05-07',
        checkOut: '2026-05-10',
      },
    ]);
    expect(page.gotos).toEqual([
      'https://www.airbnb.com/hosting/messages',
      fallbackUrl,
    ]);
  });

  it('ignores unsafe last known thread cookies and keeps failing closed', async () => {
    const page = makeFakeInboxPage({
      cookies: [{ name: '__ps_lu', value: 'https://evil.com/hosting/messages/2470285483' }],
      loaderPresent: true,
      bodyText: 'Messages',
    });

    await expect(listInboxThreads(page as never, 10)).rejects.toThrow(
      /inbox_list_unavailable/,
    );
    expect(page.gotos).toEqual(['https://www.airbnb.com/hosting/messages']);
    expect(page.reloads).toBe(1);
  });

  it('returns an empty list for an explicit empty inbox state', async () => {
    const page = makeFakeInboxPage({
      bodyText: 'Messages',
      sidebarText: 'No messages yet',
    });

    await expect(listInboxThreads(page as never, 10)).resolves.toEqual([]);
  });

  it('does not treat message-pane empty-ish copy as an empty inbox', async () => {
    const page = makeFakeInboxPage({
      bodyText: 'Messages\nGuest says: I am all caught up now.',
      loaderPresent: true,
      sidebarText: '',
    });

    await expect(listInboxThreads(page as never, 10)).rejects.toThrow(
      /inbox_list_unavailable/,
    );
  });

  it('does not treat active thread text inside the marker as an empty inbox', async () => {
    const page = makeFakeInboxPage({
      bodyText: 'Messages',
      messageListPresent: true,
      sidebarText: 'Guest says: I have no messages from the cleaner.',
    });

    await expect(listInboxThreads(page as never, 10)).rejects.toThrow(
      /inbox_list_unavailable/,
    );
  });
});
