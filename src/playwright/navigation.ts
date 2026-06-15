/**
 * Shared Airbnb navigation helper with SPA-intercept recovery.
 *
 * On long Airbnb listing ids (e.g. 19-digit ids like the multicalendar pages
 * use), Airbnb's SPA intercepts the navigation and completes routing
 * client-side; `page.goto` then throws net::ERR_ABORTED on EVERY attempt, so a
 * plain goto-retry loop fails 100% of the time. Mirrors the proven production
 * behavior in ~/google-scripts/airbnb/playwright-sender/airbnb-sender.js
 * (ensureOnCalendar): treat ERR_ABORTED as a SPA intercept, wait ~4s for
 * client-side routing to settle, then validate the landing state instead of
 * retrying. Only throw if validation fails.
 */

import type { Page } from 'playwright';

const GOTO_TIMEOUT_MS = 45_000;
const GOTO_MAX_ATTEMPTS = 3;
const SPA_SETTLE_MS = 4_000;
const SPA_READY_SELECTOR_TIMEOUT_MS = 15_000;

export interface GotoSpaValidation {
  /** Substring the settled page URL must contain (expected path and/or listing id). */
  urlIncludes: string;
  /** Selector that must render once client-side routing settles (e.g. '[data-date]'). */
  readySelector?: string;
}

/**
 * Navigate with retry on timeouts and SPA-intercept recovery on ERR_ABORTED.
 *
 * - Timeout errors retry up to {@link GOTO_MAX_ATTEMPTS} with linear backoff.
 * - ERR_ABORTED / "user aborted" is NOT retried: the SPA already took over the
 *   navigation, so we wait for client-side routing and validate the result.
 * - Any other error throws immediately.
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  validation: GotoSpaValidation,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < GOTO_MAX_ATTEMPTS; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ERR_ABORTED') || message.includes('user aborted')) {
        // Airbnb SPA intercepted the navigation and is completing it
        // client-side. Give routing time to settle, then validate.
        await page.waitForTimeout(SPA_SETTLE_MS);
        if (await spaNavigationSettled(page, validation)) {
          return;
        }
        throw err;
      }
      if (!message.includes('Timeout')) {
        throw err;
      }
      await page.waitForTimeout(1_000 + attempt * 1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function spaNavigationSettled(page: Page, validation: GotoSpaValidation): Promise<boolean> {
  if (!page.url().includes(validation.urlIncludes)) {
    return false;
  }
  if (validation.readySelector) {
    return page
      .waitForSelector(validation.readySelector, { timeout: SPA_READY_SELECTOR_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
  }
  return true;
}
