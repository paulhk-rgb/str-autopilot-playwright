/**
 * Persistent Playwright browser context manager.
 * Spec: ~/str-autopilot/specs/DAY4-integration-patterns.md §2.4 (step 4 inject-cookies, step 5 sync)
 *
 * Stealth flags mirror ~/google-scripts/airbnb/playwright-sender/server.js — the proven local
 * production stack. Airbnb detects headless Chromium; we run headful via Xvfb.
 */

import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
];

const IGNORE_DEFAULT_ARGS = ['--enable-automation'];

let ctxPromise: Promise<BrowserContext> | null = null;
let lastAirbnbRequestAt: Date | null = null;

export interface BrowserOptions {
  profileDir: string;
  headless?: boolean; // default: false in production (headful via Xvfb)
}

export async function getBrowserContext(opts: BrowserOptions): Promise<BrowserContext> {
  if (ctxPromise) {
    try {
      const ctx = await ctxPromise;
      // Sanity check: calling .pages() throws if context was closed externally.
      ctx.pages();
      return ctx;
    } catch {
      ctxPromise = null;
    }
  }

  ctxPromise = chromium.launchPersistentContext(opts.profileDir, {
    headless: opts.headless ?? false,
    viewport: { width: 1280, height: 800 },
    args: STEALTH_ARGS,
    ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
    // Airbnb's rate-limiter is UA-sensitive — explicit UA avoids headless-chrome fingerprint leakage.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
  });

  const ctx = await ctxPromise;
  ctx.on('close', () => {
    ctxPromise = null;
  });
  // Attach SPA listener at the BROWSER-CONTEXT level so any page-navigated
  // GraphQL traffic (including the inject-cookies /hosting/today probe in
  // api mode, which skips UI navigations entirely) populates observations.
  // Per Gemini + Codex v0.3 audit: page-level lazy attach in sync.ts misses
  // organic SPA traffic when the page that fires the SPA isn't the page the
  // listener was bound to.
  try {
    getSpaListener().installOnContext(ctx);
  } catch {
    // Defensive: never let listener wiring block context creation.
  }
  return ctx;
}

export async function closeBrowserContext(): Promise<void> {
  if (!ctxPromise) return;
  try {
    const ctx = await ctxPromise;
    await ctx.close();
  } catch {
    // already dead
  } finally {
    ctxPromise = null;
  }
}

/** Mark "last Airbnb request" — reported in /health. */
export function markAirbnbRequest(): void {
  lastAirbnbRequestAt = new Date();
}

export function getLastAirbnbRequestAt(): Date | null {
  return lastAirbnbRequestAt;
}

/**
 * Check whether the persistent context has a valid Airbnb session cookie.
 * Spec §2.4 step 5 references cookie_valid in /health responses.
 *
 * Airbnb's session cookies are `_airbed_session_id` and `_aat`. Both must be present.
 * We DO NOT hit airbnb.com on /health — that would generate traffic on every 30s health check.
 *
 * Lenient: swallows `ctx.cookies()` errors and returns `false`. Used by /health
 * where a closed/corrupt context is treated as "no session" without surfacing
 * the underlying error. Endpoints that need to distinguish "no session" from
 * "context error" should use `readAirbnbSessionStrict` instead.
 */
export async function hasAirbnbSession(ctx: BrowserContext): Promise<boolean> {
  try {
    return await readAirbnbSessionStrict(ctx);
  } catch {
    return false;
  }
}

/**
 * Strict variant: throws on `ctx.cookies()` failures (closed context, etc.)
 * instead of swallowing them. Used by /scrape-reservation-list so a transient
 * browser error becomes 500 `session_check_failed` (or 409 `auth_epoch_changed`
 * if a rotation overlapped) rather than being misclassified as 401
 * `invalid_cookies`.
 */
export async function readAirbnbSessionStrict(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies('https://www.airbnb.com');
  const names = new Set(cookies.map((c) => c.name));
  return names.has('_airbed_session_id') && names.has('_aat');
}

/** Open a fresh page reusing the context. Callers MUST await page.close() when done. */
export async function openPage(ctx: BrowserContext): Promise<Page> {
  return ctx.newPage();
}

// ============================================================================
// SPA observation listener (v0.3) — singleton attached to the persistent context.
// ============================================================================
import { SpaListener } from './spa-listener';
let spaListener: SpaListener | null = null;
const installedOnPages = new WeakSet<Page>();

/** Lazily-initialized singleton listener used by api-reader-cycle. */
export function getSpaListener(): SpaListener {
  if (!spaListener) spaListener = new SpaListener();
  return spaListener;
}

/**
 * Idempotently attach the SPA listener to a page. Safe to call on every /sync —
 * the listener short-circuits its second install on the same page.
 */
export function ensureSpaListenerOnPage(page: Page): SpaListener {
  const l = getSpaListener();
  if (!installedOnPages.has(page)) {
    l.install(page);
    installedOnPages.add(page);
  }
  return l;
}
