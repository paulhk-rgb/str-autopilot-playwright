import { describe, expect, it } from 'vitest';

import { __scrapeInboxTestHooks } from '../src/playwright/scrape-inbox';

const { parseInboxThreadSummary } = __scrapeInboxTestHooks;

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
});
