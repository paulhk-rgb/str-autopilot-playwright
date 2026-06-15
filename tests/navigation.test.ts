import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { gotoWithRetry } from '../src/playwright/navigation';

const CALENDAR_URL = 'https://www.airbnb.com/multicalendar/1234567890123456789';
const VALIDATION = {
  urlIncludes: '/multicalendar/1234567890123456789',
  readySelector: '[data-date]',
};

function buildPage(overrides: Record<string, unknown> = {}): Page {
  return {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => CALENDAR_URL),
    waitForTimeout: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as Page;
}

describe('gotoWithRetry SPA-intercept recovery', () => {
  it('returns after a clean navigation without touching validation', async () => {
    const page = buildPage();

    await gotoWithRetry(page, CALENDAR_URL, VALIDATION);

    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it('recovers from ERR_ABORTED when the SPA finished routing client-side', async () => {
    const page = buildPage({
      goto: vi.fn(async () => {
        throw new Error(`page.goto: net::ERR_ABORTED at ${CALENDAR_URL}`);
      }),
    });

    await gotoWithRetry(page, CALENDAR_URL, VALIDATION);

    // ERR_ABORTED means the SPA already owns the navigation — retrying goto
    // fails 100% of the time, so there must be exactly ONE attempt.
    expect(page.goto).toHaveBeenCalledTimes(1);
    // Waits ~4s for client-side routing to settle before validating.
    expect(page.waitForTimeout).toHaveBeenCalledWith(4_000);
    expect(page.waitForSelector).toHaveBeenCalledWith('[data-date]', expect.objectContaining({
      timeout: expect.any(Number),
    }));
  });

  it('treats the "user aborted" message variant as a SPA intercept', async () => {
    const page = buildPage({
      goto: vi.fn(async () => {
        throw new Error('page.goto: user aborted');
      }),
    });

    await expect(gotoWithRetry(page, CALENDAR_URL, VALIDATION)).resolves.toBeUndefined();
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('throws the original ERR_ABORTED when the settled URL does not match', async () => {
    const page = buildPage({
      goto: vi.fn(async () => {
        throw new Error(`page.goto: net::ERR_ABORTED at ${CALENDAR_URL}`);
      }),
      url: vi.fn(() => 'https://www.airbnb.com/login'),
    });

    await expect(gotoWithRetry(page, CALENDAR_URL, VALIDATION)).rejects.toThrow('ERR_ABORTED');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it('throws the original ERR_ABORTED when the ready selector never renders', async () => {
    const page = buildPage({
      goto: vi.fn(async () => {
        throw new Error(`page.goto: net::ERR_ABORTED at ${CALENDAR_URL}`);
      }),
      waitForSelector: vi.fn(async () => {
        throw new Error('page.waitForSelector: Timeout 15000ms exceeded.');
      }),
    });

    await expect(gotoWithRetry(page, CALENDAR_URL, VALIDATION)).rejects.toThrow('ERR_ABORTED');
  });

  it('validates by URL alone when no ready selector is configured', async () => {
    const page = buildPage({
      goto: vi.fn(async () => {
        throw new Error(`page.goto: net::ERR_ABORTED at ${CALENDAR_URL}`);
      }),
    });

    await expect(gotoWithRetry(page, CALENDAR_URL, {
      urlIncludes: '/multicalendar/1234567890123456789',
    })).resolves.toBeUndefined();
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it('still retries timeouts with backoff', async () => {
    const goto = vi.fn()
      .mockRejectedValueOnce(new Error('page.goto: Timeout 45000ms exceeded.'))
      .mockRejectedValueOnce(new Error('page.goto: Timeout 45000ms exceeded.'))
      .mockResolvedValueOnce(undefined);
    const page = buildPage({ goto });

    await gotoWithRetry(page, CALENDAR_URL, VALIDATION);

    expect(goto).toHaveBeenCalledTimes(3);
  });

  it('throws the last timeout after exhausting retries', async () => {
    const page = buildPage({
      goto: vi.fn(async () => {
        throw new Error('page.goto: Timeout 45000ms exceeded.');
      }),
    });

    await expect(gotoWithRetry(page, CALENDAR_URL, VALIDATION)).rejects.toThrow('Timeout');
    expect(page.goto).toHaveBeenCalledTimes(3);
  });

  it('throws non-retryable navigation errors immediately', async () => {
    const page = buildPage({
      goto: vi.fn(async () => {
        throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED');
      }),
    });

    await expect(gotoWithRetry(page, CALENDAR_URL, VALIDATION)).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});
