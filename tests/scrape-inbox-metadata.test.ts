import { describe, expect, it } from 'vitest';

import { __scrapeInboxTestHooks } from '../src/playwright/scrape-inbox';

const { isExplicitEmptyInboxText, listInboxThreads, parseInboxThreadSummary } =
  __scrapeInboxTestHooks;

type FakeElement = {
  getAttribute: (name: string) => string | null;
  textContent: string | null;
  innerText?: string;
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
  gotoError?: Error;
  url?: string;
}) {
  const rows = input.rows ?? [];
  const rowElements = rows.map((row) => makeElement(`inbox_list_${row.id}`, row.text));
  const sidebarElement =
    input.sidebarText !== undefined
      ? [makeElement('inbox-container-marker', input.sidebarText)]
      : [];
  const testIdElements = [
    ...(input.loaderPresent ? [makeElement('inbox-list-loader', '')] : []),
    ...sidebarElement,
    ...rowElements,
  ];
  const doc = {
    title: 'Messages • Airbnb',
    body: { innerText: input.bodyText ?? 'Messages' },
    querySelector: (selector: string) => {
      if (selector === '[data-testid="inbox-list-loader"]' && input.loaderPresent) {
        return makeElement('inbox-list-loader', '');
      }
      if (selector === '[data-testid="inbox-container-marker"]') {
        return sidebarElement[0] ?? null;
      }
      if (selector === '[data-testid="orbital-panel-inbox"]') {
        return sidebarElement[0] ?? null;
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'a[data-testid^="inbox_list_"]') return rowElements;
      if (selector === '[data-testid]') return testIdElements;
      if (selector === 'a') return rowElements;
      return [];
    },
  };
  const page = {
    reloads: 0,
    goto: async () => {
      if (input.gotoError) throw input.gotoError;
    },
    url: () => input.url ?? 'https://www.airbnb.com/hosting/messages',
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
});
