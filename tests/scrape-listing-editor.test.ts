import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import type { MachineEnv } from '../src/lib/env';

vi.mock('../src/playwright/browser', () => ({
  getBrowserContext: vi.fn(),
  readAirbnbSessionStrict: vi.fn(),
}));

vi.mock('../src/playwright/scrape-listing-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright/scrape-listing-editor')>();
  return {
    ...actual,
    scrapeListingEditor: vi.fn(),
  };
});

import { scrapeListingEditorHandler } from '../src/endpoints/scrape-listing-editor';
import * as browserModule from '../src/playwright/browser';
import * as scraperModule from '../src/playwright/scrape-listing-editor';
import {
  __listingEditorScraperTestHooks,
  ListingEditorScrapeError,
} from '../src/playwright/scrape-listing-editor';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';
import { __resetSingleFlightForTesting } from '../src/lib/single-flight';

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
  __resetSingleFlightForTesting();
  _resetAuthEpochForTesting();
  beginCookieInject();
  markAuthEpochReady();
  vi.mocked(browserModule.getBrowserContext).mockReset();
  vi.mocked(browserModule.readAirbnbSessionStrict).mockReset();
  vi.mocked(scraperModule.scrapeListingEditor).mockReset();
  vi.mocked(browserModule.getBrowserContext).mockResolvedValue({} as never);
  vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(true);
});

describe('listing editor scraper guards', () => {
  it('allows only numeric listing IDs and allowlisted editor paths', () => {
    expect(__listingEditorScraperTestHooks.normalizeListingId(' 12345678 ')).toBe('12345678');
    expect(() => __listingEditorScraperTestHooks.normalizeListingId('abc')).toThrow('invalid_listing_id');
    expect(__listingEditorScraperTestHooks.normalizeRequestedPaths(['/details/amenities'])).toEqual([
      '/details/amenities',
    ]);
    expect(() => __listingEditorScraperTestHooks.normalizeRequestedPaths(['/financials'])).toThrow(
      'invalid_editor_path',
    );
  });

  it('extracts listing IDs with an anchored Airbnb editor URL check', () => {
    expect(
      __listingEditorScraperTestHooks.extractEditorListingId(
        'https://www.airbnb.com/hosting/listings/editor/12345678/details/photo-tour',
      ),
    ).toBe('12345678');
    expect(
      __listingEditorScraperTestHooks.extractEditorListingId(
        'https://www.airbnb.com/hosting/listings/editor/123456789/details/photo-tour',
      ),
    ).not.toBe('12345678');
    expect(
      __listingEditorScraperTestHooks.extractEditorListingId(
        'https://evil.example.com/hosting/listings/editor/12345678/details/photo-tour',
      ),
    ).toBeNull();
  });

  it('keeps custom ARIA controls in the snapshot selector contract', () => {
    const source = readFileSync(
      join(__dirname, '../src/playwright/scrape-listing-editor.ts'),
      'utf8',
    );
    expect(source).toContain('[role="checkbox"]');
    expect(source).toContain('[role="switch"]');
    expect(source).toContain('aria-checked');
    expect(source).toContain('contenteditable');
  });
});

describe('/scrape-listing-editor endpoint', () => {
  it('rejects malformed bodies before opening the browser', async () => {
    const { req, res, statusSpy } = buildReqRes({
      host_id: HOST_ID,
      listing_id: 'abc',
    });

    await scrapeListingEditorHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(browserModule.getBrowserContext).not.toHaveBeenCalled();
  });

  it('rejects host mismatches', async () => {
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: 'other-host',
      listing_id: '12345678',
    });

    await scrapeListingEditorHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'host_id_mismatch' });
  });

  it('maps missing Airbnb session cookies to invalid_cookies', async () => {
    vi.mocked(browserModule.readAirbnbSessionStrict).mockResolvedValue(false);
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      listing_id: '12345678',
    });

    await scrapeListingEditorHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: 'invalid_cookies' });
    expect(scraperModule.scrapeListingEditor).not.toHaveBeenCalled();
  });

  it('returns page snapshots from the authenticated editor scraper', async () => {
    vi.mocked(scraperModule.scrapeListingEditor).mockResolvedValueOnce({
      schema_version: 1,
      listing_id: '12345678',
      pages: [
        {
          path: '/details/amenities',
          url: 'https://www.airbnb.com/hosting/listings/editor/12345678/details/amenities',
          title: 'Amenities',
          text: 'Wifi\nPets allowed',
          fields: [{ label: 'Pets allowed', checked: true }],
          links: [],
        },
      ],
      diagnostics: {
        scraped_paths: ['/details/amenities'],
        failed_paths: [],
        scraped_at: '2026-05-19T00:00:00.000Z',
      },
    });
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      listing_id: '12345678',
      paths: ['/details/amenities'],
    });

    await scrapeListingEditorHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(scraperModule.scrapeListingEditor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ listing_id: '12345678', paths: ['/details/amenities'] }),
    );
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: 1,
        listing_id: '12345678',
        pages: expect.arrayContaining([expect.objectContaining({ path: '/details/amenities' })]),
      }),
    );
  });

  it('surfaces listing identity mismatches as conflict responses', async () => {
    vi.mocked(scraperModule.scrapeListingEditor).mockRejectedValueOnce(
      new ListingEditorScrapeError('listing_id_mismatch'),
    );
    const { req, res, statusSpy, jsonSpy } = buildReqRes({
      host_id: HOST_ID,
      listing_id: '12345678',
    });

    await scrapeListingEditorHandler(env)(req, res);

    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: 'listing_id_mismatch',
      message: 'listing_id_mismatch',
    });
  });
});
