/**
 * POST /inject-cookies — HMAC-authed.
 * Spec §2.4 step 4:
 *   Body: { cookies: CookieJar[] }
 * Spec §2.4 step 4b (cross-tenant verification):
 *   Response includes authenticated airbnb_user_id. Provisioner compares vs
 *   playwright_sessions.airbnb_user_id (first-connect establishes it).
 *
 * Response:
 *   { status: 'ok', airbnb_user_id: string }
 *   | { status: 'error', reason: 'invalid_cookies' | 'airbnb_blocked' | 'browser_failed' | 'verify_failed' }
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { getBrowserContext, hasAirbnbSession, markAirbnbRequest, openPage } from '../playwright/browser';

interface AirbnbCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;      // unix seconds, -1 = session cookie
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

interface InjectCookiesBody {
  cookies: AirbnbCookie[];
}

function isValidCookieJar(body: unknown): body is InjectCookiesBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as { cookies?: unknown };
  if (!Array.isArray(b.cookies)) return false;
  for (const c of b.cookies) {
    if (!c || typeof c !== 'object') return false;
    const cc = c as AirbnbCookie;
    if (typeof cc.name !== 'string' || typeof cc.value !== 'string') return false;
    if (typeof cc.domain !== 'string' || typeof cc.path !== 'string') return false;
  }
  return true;
}

export function injectCookiesHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidCookieJar(req.body)) {
      return res.status(400).json({ status: 'error', reason: 'malformed_body' });
    }

    const cookies = req.body.cookies;
    const names = new Set(cookies.map((c) => c.name));
    if (!names.has('_airbnb_session_id') || !names.has('_aat')) {
      return res.status(400).json({ status: 'error', reason: 'invalid_cookies' });
    }

    let ctx;
    try {
      ctx = await getBrowserContext({ profileDir: env.PROFILE_DIR });
    } catch (err) {
      return res.status(500).json({
        status: 'error',
        reason: 'browser_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Playwright expects each cookie to have `url` OR (`domain` + `path`). Some older exports
    // omit sameSite; default to 'Lax' to match Chromium defaults.
    try {
      await ctx.addCookies(
        cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: typeof c.expires === 'number' ? c.expires : undefined,
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? true,
          sameSite: c.sameSite ?? 'Lax',
        })),
      );
    } catch (err) {
      return res.status(400).json({
        status: 'error',
        reason: 'invalid_cookies',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Verify session by navigating to the hosting dashboard.
    // Response must include airbnb_user_id for spec §2.4 step 4b cross-tenant check.
    let airbnbUserId: string | null = null;
    const page = await openPage(ctx);
    try {
      markAirbnbRequest();
      await page.goto('https://www.airbnb.com/hosting/today', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      // Heuristic: /login redirect means cookies are invalid/expired.
      const urlAfterNav = page.url();
      if (urlAfterNav.includes('/login') || urlAfterNav.includes('/signup')) {
        return res.status(401).json({ status: 'error', reason: 'invalid_cookies' });
      }

      // Extract airbnb_user_id. Airbnb embeds the logged-in user id in a cookie called `aat`
      // and in meta tags on /hosting pages. We try a few sources.
      // NOTE: `document` inside page.evaluate refers to the browser DOM, not Node's globals.
      // We pass a function that runs in the page context — TS typechecks this as `any`-shaped.
      airbnbUserId = await page.evaluate(
        () => {
          const d = (globalThis as unknown as { document?: unknown }).document as
            | {
                querySelector(sel: string): { getAttribute(n: string): string | null } | null;
                body?: { dataset?: Record<string, string | undefined> };
              }
            | undefined;
          if (!d) return null;
          const meta = d.querySelector('meta[name="airbnb-user-id"]');
          if (meta) {
            const v = meta.getAttribute('content');
            if (v) return v;
          }
          const bodyUid = d.body?.dataset?.['userId'];
          if (bodyUid) return bodyUid;
          return null;
        },
      ) as string | null;

      if (!airbnbUserId) {
        // Fall back to cookie-based derivation: the `_user_attributes` cookie includes JSON with id.
        const cookiesNow = await ctx.cookies('https://www.airbnb.com');
        const ua = cookiesNow.find((c) => c.name === '_user_attributes');
        if (ua?.value) {
          try {
            const decoded = decodeURIComponent(ua.value);
            const match = decoded.match(/"id"\s*:\s*"?(\d+)/);
            if (match?.[1]) airbnbUserId = match[1];
          } catch {
            // ignore
          }
        }
      }

      if (!airbnbUserId) {
        return res.status(500).json({ status: 'error', reason: 'verify_failed' });
      }
    } catch (err) {
      return res.status(500).json({
        status: 'error',
        reason: 'airbnb_blocked',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await page.close().catch(() => undefined);
    }

    // Defense-in-depth: confirm we actually have session cookies in the context.
    const ok = await hasAirbnbSession(ctx);
    if (!ok) {
      return res.status(500).json({ status: 'error', reason: 'verify_failed' });
    }

    return res.status(200).json({ status: 'ok', airbnb_user_id: airbnbUserId });
  };
}
