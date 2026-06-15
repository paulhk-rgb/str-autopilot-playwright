/**
 * Behavior tests for the real scrapeMarketPrices pipeline using a fake page
 * whose evaluate() runs the actual in-page extraction functions against a
 * stubbed DOM. Endpoint-level tests live in scrape-market-prices.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import {
  scrapeMarketPrices,
  type MarketScrapeConfig,
} from '../src/playwright/scrape-market-prices';

interface FakeCard {
  innerText: string;
  querySelector: (selector: string) => { href: string } | null;
}

function airbnbCard(roomId: string, lines: string[]): FakeCard {
  return {
    innerText: lines.join('\n'),
    querySelector: (selector: string) =>
      selector.includes('/rooms/')
        ? { href: `https://www.airbnb.com/rooms/${roomId}?source=search` }
        : null,
  };
}

function bookingCard(lines: string[]): FakeCard {
  return { innerText: lines.join('\n'), querySelector: () => null };
}

function createFakeSearchContext(world: {
  airbnbCardsForUrl: (url: string) => FakeCard[];
  bookingCardsForUrl?: (url: string) => FakeCard[];
  bodyText?: string;
}) {
  let currentUrl = '';
  const cardsForSelector = (selector: string): FakeCard[] => {
    if (selector === '[data-testid="property-card"]') {
      return world.bookingCardsForUrl?.(currentUrl) ?? [];
    }
    return world.airbnbCardsForUrl(currentUrl);
  };

  const page = {
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    url: () => currentUrl,
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async (selector: string) => {
      if (cardsForSelector(selector).length === 0) {
        throw new Error(`page.waitForSelector: Timeout 15000ms exceeded waiting for ${selector}`);
      }
      return {};
    }),
    evaluate: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
      // Run the REAL serialized in-page function against a stubbed DOM.
      vi.stubGlobal('document', {
        body: { innerText: world.bodyText ?? '' },
        querySelectorAll: (selector: string) => cardsForSelector(selector),
      });
      vi.stubGlobal('window', { scrollBy: () => undefined });
      try {
        return fn(arg);
      } finally {
        vi.unstubAllGlobals();
      }
    }),
    close: vi.fn(async () => undefined),
  };

  const ctx = { newPage: async () => page } as unknown as BrowserContext;
  return { ctx, page };
}

function marketConfig(overrides: Partial<MarketScrapeConfig> = {}): MarketScrapeConfig {
  return {
    location: 'Portland, Maine',
    currency: 'USD',
    adults: 2,
    bedroom_counts: [1, 2],
    night_counts: [1],
    horizon_days: 1,
    target_dates: ['2026-07-01'],
    exclude_listing_ids: [],
    hotel_names: [],
    hotel_tax_multiplier: 1,
    min_price: 50,
    max_price: 999,
    ...overrides,
  };
}

const FAST_OPTS = { waitAfterLoadMs: 0, interSearchDelayMs: 0, interDateDelayMs: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scrapeMarketPrices bedroom search modes', () => {
  it('defaults to one min/max-filtered search per bedroom count', async () => {
    const { ctx, page } = createFakeSearchContext({
      airbnbCardsForUrl: (url) => {
        if (url.includes('min_bedrooms=1')) {
          // No "N bedroom" line — many Airbnb card variants omit it.
          return [airbnbCard('101', ['Home in Portland', 'Cozy studio loft', '$150 for 1 night'])];
        }
        if (url.includes('min_bedrooms=2')) {
          return [airbnbCard('202', ['Home in Portland', 'Big place', '2 bedrooms', '$250 for 1 night'])];
        }
        return [];
      },
    });

    const result = await scrapeMarketPrices(ctx, { market: marketConfig(), ...FAST_OPTS });

    const gotoUrls = page.goto.mock.calls.map((call) => call[0] as string);
    expect(gotoUrls).toHaveLength(2);
    expect(gotoUrls[0]).toContain('min_bedrooms=1&max_bedrooms=1');
    expect(gotoUrls[1]).toContain('min_bedrooms=2&max_bedrooms=2');

    expect(result.diagnostics.searches_attempted).toBe(2);
    expect(result.diagnostics.searches_failed).toBe(0);
    const listings = result.dates[0].listings;
    // Card without bedroom text is KEPT and defaults to the searched count.
    expect(listings).toContainEqual(expect.objectContaining({ roomId: '101', bedrooms: 1, price1Night: 150 }));
    expect(listings).toContainEqual(expect.objectContaining({ roomId: '202', bedrooms: 2, price1Night: 250 }));
  });

  it('runs a single unfiltered search when shared_bedroom_search is opted in', async () => {
    const { ctx, page } = createFakeSearchContext({
      airbnbCardsForUrl: () => [
        airbnbCard('101', ['Home in Portland', 'Cozy spot', '1 bedroom', '$150 for 1 night']),
        // No bedroom text — shared mode cannot attribute it and drops it.
        airbnbCard('999', ['Home in Portland', 'Mystery card', '$300 for 1 night']),
      ],
    });

    const result = await scrapeMarketPrices(ctx, {
      market: marketConfig({ shared_bedroom_search: true }),
      ...FAST_OPTS,
    });

    const gotoUrls = page.goto.mock.calls.map((call) => call[0] as string);
    expect(gotoUrls).toHaveLength(1);
    expect(gotoUrls[0]).not.toContain('min_bedrooms');

    const listings = result.dates[0].listings;
    expect(listings).toContainEqual(expect.objectContaining({ roomId: '101', bedrooms: 1 }));
    expect(listings.map((listing) => listing.roomId)).not.toContain('999');
  });
});

describe('scrapeMarketPrices failure accounting', () => {
  it('counts a search that extracts zero listings as failed with reason zero_listings', async () => {
    const { ctx } = createFakeSearchContext({
      // Card renders (so the selector wait passes) but has no parsable price.
      airbnbCardsForUrl: () => [airbnbCard('301', ['Home in Portland', 'No price printed'])],
    });

    const result = await scrapeMarketPrices(ctx, {
      market: marketConfig({ bedroom_counts: [1] }),
      ...FAST_OPTS,
    });

    expect(result.diagnostics.searches_attempted).toBe(1);
    expect(result.diagnostics.searches_failed).toBe(1);
    expect(result.diagnostics.failed_searches).toEqual([
      { date: '2026-07-01', source: 'airbnb', reason: 'zero_listings' },
    ]);
    expect(result.diagnostics.blocked).toBe(false);
    expect(result.dates[0].listings).toEqual([]);
  });

  it('fails a search with no_cards_rendered when cards never appear (not blocked)', async () => {
    const { ctx } = createFakeSearchContext({
      airbnbCardsForUrl: () => [],
    });

    const result = await scrapeMarketPrices(ctx, {
      market: marketConfig({ bedroom_counts: [1] }),
      ...FAST_OPTS,
    });

    expect(result.diagnostics.searches_failed).toBe(1);
    expect(result.diagnostics.failed_searches).toEqual([
      { date: '2026-07-01', source: 'airbnb', reason: 'no_cards_rendered' },
    ]);
    expect(result.diagnostics.blocked).toBe(false);
    expect(result.success).toBe(true);
  });
});

describe('scrapeMarketPrices Booking.com challenge handling', () => {
  it('fails the hotel search when property cards never render after the challenge', async () => {
    const { ctx } = createFakeSearchContext({
      airbnbCardsForUrl: () => [
        airbnbCard('101', ['Home in Portland', 'Cozy spot', '1 bedroom', '$150 for 1 night']),
      ],
      bookingCardsForUrl: () => [],
    });

    const result = await scrapeMarketPrices(ctx, {
      market: marketConfig({ bedroom_counts: [1], hotel_names: ['Harbor Hotel'] }),
      ...FAST_OPTS,
    });

    expect(result.diagnostics.failed_searches).toContainEqual(
      { date: '2026-07-01', source: 'booking', reason: 'no_cards_rendered' },
    );
    expect(result.dates[0].hotels).toEqual([]);
    expect(result.dates[0].listings).toHaveLength(1);
  });

  it('extracts hotels once property cards render', async () => {
    const { ctx } = createFakeSearchContext({
      airbnbCardsForUrl: () => [
        airbnbCard('101', ['Home in Portland', 'Cozy spot', '1 bedroom', '$150 for 1 night']),
      ],
      bookingCardsForUrl: () => [bookingCard(['Harbor Hotel Downtown', '$199'])],
    });

    const result = await scrapeMarketPrices(ctx, {
      market: marketConfig({
        bedroom_counts: [1],
        hotel_names: ['Harbor Hotel'],
        hotel_tax_multiplier: 1.18,
      }),
      ...FAST_OPTS,
    });

    expect(result.dates[0].hotels).toEqual([
      { name: 'Harbor Hotel Downtown', listPrice: 199, priceWithTax: 235, source: 'booking' },
    ]);
    expect(result.diagnostics.searches_failed).toBe(0);
  });
});

describe('scrapeMarketPrices price line parsing', () => {
  it('takes the discounted (last) price on strikethrough multi-price lines', async () => {
    const { ctx } = createFakeSearchContext({
      airbnbCardsForUrl: () => [
        airbnbCard('401', ['Home in Portland', 'Deal spot', '1 bedroom', '$649 $589 for 2 nights']),
      ],
    });

    const result = await scrapeMarketPrices(ctx, {
      market: marketConfig({ bedroom_counts: [1], night_counts: [2] }),
      ...FAST_OPTS,
    });

    expect(result.dates[0].listings).toContainEqual(expect.objectContaining({
      roomId: '401',
      price2NightTotal: 589,
      price2NightPerNight: 295,
      minStay: 2,
    }));
  });

  it('accepts bare anchored money lines that match no keyword branch', async () => {
    const { ctx } = createFakeSearchContext({
      airbnbCardsForUrl: () => [
        airbnbCard('501', ['Home in Portland', 'Plain card', '1 bedroom', '$215']),
      ],
    });

    const result = await scrapeMarketPrices(ctx, {
      market: marketConfig({ bedroom_counts: [1] }),
      ...FAST_OPTS,
    });

    expect(result.dates[0].listings).toContainEqual(expect.objectContaining({
      roomId: '501',
      price1Night: 215,
    }));
    expect(result.diagnostics.searches_failed).toBe(0);
  });
});
