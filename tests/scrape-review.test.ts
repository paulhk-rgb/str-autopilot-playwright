/**
 * /scrape-review endpoint tests.
 *
 * This endpoint is intentionally direct-anchor only. It may scrape a review
 * detail page by review_url or confirmation_code, but must not fall back to
 * name-only review-list searching.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';
import type { ScrapedReviewText } from '../src/playwright/scrape-review';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/scrape-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright/scrape-review')>();
  return {
    ...actual,
    scrapeReviewText: vi.fn(),
  };
});

import { scrapeReviewHandler } from '../src/endpoints/scrape-review';
import * as browserModule from '../src/playwright/browser';
import * as scraperModule from '../src/playwright/scrape-review';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';

const HOST_ID = '11111111-2222-3333-4444-555555555555';

const env: MachineEnv = {
  HMAC_SECRET: '7b2e2f1a0d6c4e6e89ab22c3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d',
  HOST_ID,
  CALLBACK_URL: 'http://localhost:9999/callback',
  PORT: 8080,
  PROFILE_DIR: '/tmp/test-profile',
  INBOX_READER_MODE: 'ui',
  AIRBNB_API_USER_ID: null,
  AIRBNB_API_GLOBAL_USER_ID: null,
  AIRBNB_API_KEY: 'k',
  AIRBNB_API_INBOX_HASH: 'h1',
  AIRBNB_API_THREAD_HASH: 'h2',
  WATERMARKS_PATH: '/tmp/wm.json',
};

function scrapeResult(overrides: Partial<ScrapedReviewText> = {}): ScrapedReviewText {
  return {
    schema_version: 1,
    scraped_at: '2026-05-05T00:00:00.000Z',
    review_text: 'Alice was a thoughtful guest and left the place in great shape.',
    private_comment: 'Thanks for the local recommendations.',
    has_public_response: false,
    per_category_ratings: { cleanliness: 5, communication: 5 },
    source_url: 'https://www.airbnb.com/progress/reviews/details/HM3ZXPMNZC',
    ...overrides,
  };
}

function buildReqRes(body: unknown): {
  req: Request;
  res: Response;
  jsonSpy: ReturnType<typeof vi.fn>;
  statusSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn();
  const res = {
    status: vi.fn(),
    json: jsonSpy,
  } as unknown as Response & { status: ReturnType<typeof vi.fn> };
  res.status.mockImplementation(() => res);
  const req = { body } as Request;
  return { req, res, jsonSpy, statusSpy: res.status };
}

beforeEach(() => {
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.readAirbnbSessionStrict).mockReset();
  vi.mocked(scraperModule.scrapeReviewText).mockReset();
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();
});

describe('review scraper pure guards', () => {
  it('accepts only Airbnb review URLs and rejects lookalikes', async () => {
    const { __scrapeReviewTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-review')
    >('../src/playwright/scrape-review');

    expect(
      __scrapeReviewTestHooks.isValidAirbnbReviewUrl(
        'https://www.airbnb.com/progress/reviews/details/HM3ZXPMNZC',
      ),
    ).toBe(true);
    expect(
      __scrapeReviewTestHooks.isValidAirbnbReviewUrl(
        'https://www.airbnb.com/hosting/reservations/all?confirmationCode=HM3ZXPMNZC',
      ),
    ).toBe(false);
    expect(
      __scrapeReviewTestHooks.isValidAirbnbReviewUrl(
        'https://evil.example.com/progress/reviews/details/HM3ZXPMNZC',
      ),
    ).toBe(false);
  });

  it('builds direct detail URLs from confirmation codes and rejects sentinel guests', async () => {
    const { __scrapeReviewTestHooks, ScrapeReviewError } = await vi.importActual<
      typeof import('../src/playwright/scrape-review')
    >('../src/playwright/scrape-review');

    expect(__scrapeReviewTestHooks.reviewUrlFor({ guest_name: 'Alice', confirmation_code: 'hm3zxpmnzc' })).toBe(
      'https://www.airbnb.com/progress/reviews/details/HM3ZXPMNZC',
    );
    expect(__scrapeReviewTestHooks.isSentinelGuestName('Airbnb Guest')).toBe(true);
    expect(__scrapeReviewTestHooks.isSentinelGuestName('Alice McIntyre')).toBe(false);
    expect(() =>
      __scrapeReviewTestHooks.reviewUrlFor({
        guest_name: 'Alice',
        review_url: 'https://evil.example.com/progress/reviews/details/HM3ZXPMNZC',
      }),
    ).toThrow(ScrapeReviewError);
  });

  it('trusts direct Airbnb review URLs for weak Gmail identity when property still matches', async () => {
    const { __scrapeReviewTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-review')
    >('../src/playwright/scrape-review');

    expect(__scrapeReviewTestHooks.isWeakGuestIdentity('J.')).toBe(true);
    expect(__scrapeReviewTestHooks.isWeakGuestIdentity('A recent guest')).toBe(true);
    expect(__scrapeReviewTestHooks.isWeakGuestIdentity('Alice McIntyre')).toBe(false);
    expect(
      __scrapeReviewTestHooks.canTrustReviewSource(
        {
          guest_name: 'A recent guest',
          review_url: 'https://www.airbnb.com/progress/reviews/details/1517499442815963470?c=.pi',
          property_name: 'One Bedroom Private Unit .3 Miles from Commons',
        },
        "Alice's group of 3 May 22 - 24 One Bedroom Private Unit .3 Miles from Commons Public review",
      ),
    ).toBe(true);
    expect(
      __scrapeReviewTestHooks.canTrustReviewSource(
        {
          guest_name: 'Alice McIntyre',
          review_url: 'https://www.airbnb.com/progress/reviews/details/1517499442815963470?c=.pi',
          property_name: 'Lake House',
        },
        "Alice's group of 3 May 22 - 24 One Bedroom Private Unit .3 Miles from Commons Public review",
      ),
    ).toBe(false);
    expect(
      __scrapeReviewTestHooks.canTrustReviewSource(
        {
          guest_name: 'Alice McIntyre',
          review_url: 'https://www.airbnb.com/progress/reviews/details/1517499442815963470?c=.pi',
          property_name: 'One Bedroom Private Unit .3 Miles from Commons',
        },
        "Bob's group of 2 May 22 - 24 One Bedroom Private Unit .3 Miles from Commons Public review",
      ),
    ).toBe(false);
    expect(
      __scrapeReviewTestHooks.canTrustReviewSource(
        {
          guest_name: 'A recent guest',
          review_url: 'https://www.airbnb.com/progress/reviews/details/1517499442815963470?c=.pi',
          property_name: 'Lake House',
        },
        "Alice's group of 3 May 22 - 24 One Bedroom Private Unit .3 Miles from Commons Public review",
      ),
    ).toBe(false);
    expect(
      __scrapeReviewTestHooks.propertyMatches(
        'One Bedroom Private Unit .3 Miles from Commons',
        "Alice's group of 3 May 22 - 24 One Bedroom Private Unit .3 Miles from Commons Public review",
      ),
    ).toBe(true);
    expect(
      __scrapeReviewTestHooks.propertyMatches(
        'One Bedroom Private Unit .3 Miles from Commons',
        "Alice's group of 3 May 22 - 24 One Bedroom Private Unit .3 Miles Public review",
      ),
    ).toBe(true);
    expect(
      __scrapeReviewTestHooks.propertyMatches(
        'One Bedroom Private Unit .3 Miles from Commons',
        "Alice's group of 3 May 22 - 24 Lake House Public review",
      ),
    ).toBe(false);
  });

  it('requires property evidence when only the guest first name appears in the review dialog', async () => {
    const { __scrapeReviewTestHooks } = await vi.importActual<
      typeof import('../src/playwright/scrape-review')
    >('../src/playwright/scrape-review');

    const dialogText = "Alice's group of 3 May 22 - 24 One Bedroom Private Unit .3 Miles from Commons Public review";

    expect(
      __scrapeReviewTestHooks.canTrustGuestIdentity(
        {
          guest_name: 'Alice McIntyre',
          review_url: 'https://www.airbnb.com/progress/reviews/details/123',
          property_name: 'One Bedroom Private Unit .3 Miles from Commons',
        },
        dialogText,
      ),
    ).toBe(true);
    expect(
      __scrapeReviewTestHooks.canTrustGuestIdentity(
        {
          guest_name: 'Alice McIntyre',
          review_url: 'https://www.airbnb.com/progress/reviews/details/123',
          property_name: 'Lake House',
        },
        dialogText,
      ),
    ).toBe(false);
  });
});

describe('scrapeReviewHandler', () => {
  it('returns 400 for malformed bodies before touching the browser', async () => {
    const badBodies = [
      { host_id: HOST_ID, guest_name: 'Alice' },
      {
        host_id: HOST_ID,
        guest_name: 'Alice',
        review_url: 'https://evil.example.com/progress/reviews/details/HM3ZXPMNZC',
      },
      { host_id: HOST_ID, guest_name: 'Alice', confirmation_code: 'abc' },
    ];

    for (const body of badBodies) {
      const { req, res, statusSpy, jsonSpy } = buildReqRes(body);
      await scrapeReviewHandler(env)(req, res);
      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith({ error: 'malformed_body' });
    }
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
  });

  it('returns a specific sentinel_guest_name error before touching the browser', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      guest_name: 'Airbnb Guest',
      confirmation_code: 'HM3ZXPMNZC',
    });

    await scrapeReviewHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: 'sentinel_guest_name',
      message: 'sentinel_guest_name',
    });
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
  });

  it('returns 403 when host_id does not match machine HOST_ID', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: '99999999-9999-9999-9999-999999999999',
      guest_name: 'Alice McIntyre',
      confirmation_code: 'HM3ZXPMNZC',
    });
    await scrapeReviewHandler(env)(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'host_id_mismatch' });
  });

  it('returns 401 when the persisted Airbnb session is invalid', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      guest_name: 'Alice McIntyre',
      confirmation_code: 'HM3ZXPMNZC',
    });

    await scrapeReviewHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(scraperModule.scrapeReviewText).not.toHaveBeenCalled();
  });

  it('scrapes by confirmation code and returns the schema-v1 body', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReviewText).mockResolvedValue(scrapeResult());
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      guest_name: 'Alice McIntyre',
      confirmation_code: 'HM3ZXPMNZC',
      review_url: null,
    });

    await scrapeReviewHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeReviewText).toHaveBeenCalledWith(expect.anything(), {
      guest_name: 'Alice McIntyre',
      review_url: null,
      confirmation_code: 'HM3ZXPMNZC',
      property_name: null,
    });
    expect(jsonSpy).toHaveBeenCalledWith(scrapeResult());
  });

  it('passes property name through for direct review URL verification', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReviewText).mockResolvedValue(scrapeResult());
    const reviewUrl = 'https://www.airbnb.com/progress/reviews/details/1517499442815963470?c=.pi';
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      guest_name: 'A recent guest',
      review_url: reviewUrl,
      property_name: 'One Bedroom Private Unit .3 Miles from Commons',
    });

    await scrapeReviewHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeReviewText).toHaveBeenCalledWith(expect.anything(), {
      guest_name: 'A recent guest',
      review_url: reviewUrl,
      confirmation_code: null,
      property_name: 'One Bedroom Private Unit .3 Miles from Commons',
    });
  });

  it('maps deterministic scraper failures to non-retryable HTTP statuses', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReviewText).mockRejectedValue(
      new scraperModule.ScrapeReviewError('identity_mismatch'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      guest_name: 'Alice McIntyre',
      confirmation_code: 'HM3ZXPMNZC',
    });

    await scrapeReviewHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: 'identity_mismatch',
      message: 'identity_mismatch',
    });
  });

  it('maps no_text to 400 so staysync treats star-only reviews as deterministic', async () => {
    vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
    vi.mocked(scraperModule.scrapeReviewText).mockRejectedValue(
      new scraperModule.ScrapeReviewError('no_text'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      guest_name: 'Alice McIntyre',
      confirmation_code: 'HM3ZXPMNZC',
    });

    await scrapeReviewHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: 'no_text',
      message: 'no_text',
    });
  });
});
