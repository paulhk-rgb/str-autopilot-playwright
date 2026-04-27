/**
 * Continuous SPA observation listener.
 *
 * Per spec §3 + §4 step 2: install a `page.on('response', ...)` listener at session
 * start that captures, from the SPA's organic GraphQL traffic:
 *   - lastObservedInboxHash      — from any ViaductInboxData URL path
 *   - lastObservedThreadHash     — from any ViaductGetThreadAndDataQuery URL path
 *   - lastObservedClientVersion  — from the request's x-client-version header
 *
 * The reader uses observed values when present; falls back to env-pinned hashes
 * otherwise. This is the path-of-record for hash auto-recovery.
 *
 * Hard rule: never log full URLs (they contain `variables=...` query strings).
 * Only the hash prefix + operation name + status are loggable.
 */

import type { BrowserContext, Page } from 'playwright';

export interface SpaObservation {
  inboxHash: string | null;
  threadHash: string | null;
  clientVersion: string | null;
  /** Most recent ms timestamp at which any GraphQL response was observed. */
  lastObservedAtMs: number | null;
}

const PATH_INBOX_RE = /\/api\/v3\/ViaductInboxData\/([a-f0-9]{32,})/i;
const PATH_THREAD_RE = /\/api\/v3\/ViaductGetThreadAndDataQuery\/([a-f0-9]{32,})/i;

export class SpaListener {
  private state: SpaObservation = {
    inboxHash: null,
    threadHash: null,
    clientVersion: null,
    lastObservedAtMs: null,
  };
  private installedOnPage = false;
  private installedOnContext = false;

  /**
   * Install at the BrowserContext level. This is the preferred attachment point —
   * any page (including inject-cookies's /hosting/today navigation) propagates
   * observations. Per Gemini v0.3 audit: page-level attachment in `api` mode
   * never observes the SPA because api mode skips UI navigations.
   */
  installOnContext(ctx: BrowserContext): void {
    if (this.installedOnContext) return;
    this.installedOnContext = true;
    ctx.on('request', req => this.handleRequest(req));
  }

  /** Legacy page-level install (kept for backwards-compat with existing /sync wiring). */
  install(page: Page): void {
    if (this.installedOnPage) return;
    this.installedOnPage = true;
    page.on('request', req => this.handleRequest(req));
  }

  private handleRequest(req: { url(): string; headers(): Record<string, string> }): void {
    try {
      const url = req.url();
      if (!url.includes('/api/v3/')) return;
      const inboxMatch = url.match(PATH_INBOX_RE);
      const threadMatch = url.match(PATH_THREAD_RE);
      if (inboxMatch) {
        this.state = { ...this.state, inboxHash: inboxMatch[1] };
      }
      if (threadMatch) {
        this.state = { ...this.state, threadHash: threadMatch[1] };
      }
      if (inboxMatch || threadMatch) {
        const headers = req.headers();
        const cv = headers['x-client-version'];
        if (typeof cv === 'string' && cv.length > 0) {
          this.state = { ...this.state, clientVersion: cv };
        }
        this.state = { ...this.state, lastObservedAtMs: Date.now() };
      }
    } catch {
      // Listener errors must never throw out of the handler — Playwright would
      // surface them as unhandled rejections. Swallow + continue.
    }
  }

  observation(): SpaObservation {
    return { ...this.state };
  }

  /** Test helper — manually inject observation values for unit tests. */
  _injectForTesting(obs: Partial<SpaObservation>): void {
    this.state = { ...this.state, ...obs };
  }

  /**
   * Returns true when ALL three values have been observed at least once. The
   * cycle flow uses this as the "ready to read" gate; per spec §4 step 2 the
   * reader skips cycles until this passes.
   */
  isReady(): boolean {
    return (
      this.state.inboxHash !== null &&
      this.state.threadHash !== null &&
      this.state.clientVersion !== null
    );
  }
}
