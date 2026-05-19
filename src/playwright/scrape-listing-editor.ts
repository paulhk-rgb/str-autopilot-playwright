import type { BrowserContext, Page } from 'playwright';
import { openPage } from './browser';

export interface ListingEditorFieldSnapshot {
  tag?: string;
  type?: string;
  label?: string;
  value?: string;
  checked?: boolean;
  selectedText?: string;
}

export interface ListingEditorLinkSnapshot {
  text?: string;
  href?: string;
}

export interface ListingEditorPageSnapshot {
  path: string;
  url: string;
  title?: string;
  text?: string;
  fields?: ListingEditorFieldSnapshot[];
  links?: ListingEditorLinkSnapshot[];
}

export interface ListingEditorFailedPath {
  path: string;
  reason: string;
}

export interface ScrapeListingEditorResult {
  schema_version: 1;
  listing_id: string;
  pages: ListingEditorPageSnapshot[];
  diagnostics: {
    scraped_paths: string[];
    failed_paths: ListingEditorFailedPath[];
    scraped_at: string;
  };
}

export class ListingEditorScrapeError extends Error {
  constructor(public readonly code: 'no_pages_scraped' | 'listing_id_mismatch', message = code) {
    super(message);
    this.name = 'ListingEditorScrapeError';
  }
}

export const LISTING_EDITOR_PATHS = [
  '/details/photo-tour',
  '/details/amenities',
  '/details/house-rules',
  '/details/location',
  '/arrival/check-in-out',
  '/arrival/check-in-method',
  '/arrival/directions',
  '/arrival/wifi-details',
  '/arrival/house-manual',
  '/arrival/checkout-instructions',
  '/arrival/interaction-preferences',
] as const;

const MAX_TEXT_LENGTH = 60_000;
const MAX_FIELD_LENGTH = 8_000;
const MAX_FIELDS = 240;
const MAX_LINKS = 120;

export async function scrapeListingEditor(
  ctx: BrowserContext,
  opts: {
    listing_id: string;
    paths?: string[];
    perPageTimeoutMs?: number;
    totalTimeoutMs?: number;
    interPageDelayMs?: number;
  },
): Promise<ScrapeListingEditorResult> {
  const listingId = normalizeListingId(opts.listing_id);
  const paths = normalizeRequestedPaths(opts.paths);
  const startedAt = Date.now();
  const perPageTimeoutMs = opts.perPageTimeoutMs ?? 12_000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 75_000;
  const interPageDelayMs = opts.interPageDelayMs ?? 750;
  const pages: ListingEditorPageSnapshot[] = [];
  const failedPaths: ListingEditorFailedPath[] = [];

  const page = await openPage(ctx);
  try {
    for (const path of paths) {
      if (Date.now() - startedAt > totalTimeoutMs) {
        failedPaths.push({ path, reason: 'total_timeout' });
        break;
      }

      try {
        const snapshot = await scrapeEditorPath(page, {
          listingId,
          path,
          perPageTimeoutMs,
        });
        pages.push(snapshot);
      } catch (err) {
        failedPaths.push({ path, reason: reasonFromError(err) });
      }

      if (interPageDelayMs > 0) {
        await page.waitForTimeout(interPageDelayMs);
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  if (pages.length === 0) {
    throw new ListingEditorScrapeError('no_pages_scraped');
  }
  if (!pages.some((snapshot) => extractEditorListingId(snapshot.url) === listingId)) {
    throw new ListingEditorScrapeError('listing_id_mismatch');
  }

  return {
    schema_version: 1,
    listing_id: listingId,
    pages,
    diagnostics: {
      scraped_paths: pages.map((snapshot) => snapshot.path),
      failed_paths: failedPaths,
      scraped_at: new Date().toISOString(),
    },
  };
}

export function normalizeListingId(value: string): string {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('invalid_listing_id');
  }
  return normalized;
}

export function normalizeRequestedPaths(paths?: string[]): string[] {
  if (!paths || paths.length === 0) return [...LISTING_EDITOR_PATHS];
  const allowed = new Set<string>(LISTING_EDITOR_PATHS);
  const normalized: string[] = [];
  for (const raw of paths) {
    const path = typeof raw === 'string' ? raw.trim() : '';
    if (!allowed.has(path)) throw new Error('invalid_editor_path');
    if (!normalized.includes(path)) normalized.push(path);
  }
  return normalized;
}

export function extractEditorListingId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)airbnb\./i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/hosting\/listings\/editor\/(\d+)(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function editorUrl(listingId: string, path: string): string {
  return `https://www.airbnb.com/hosting/listings/editor/${listingId}${path}`;
}

async function scrapeEditorPath(
  page: Page,
  opts: {
    listingId: string;
    path: string;
    perPageTimeoutMs: number;
  },
): Promise<ListingEditorPageSnapshot> {
  const url = editorUrl(opts.listingId, opts.path);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.perPageTimeoutMs });
  await waitForEditorContent(page, opts.perPageTimeoutMs);

  const currentUrl = page.url();
  if (extractEditorListingId(currentUrl) !== opts.listingId) {
    throw new ListingEditorScrapeError('listing_id_mismatch');
  }

  await scrollForLazyContent(page);
  const snapshot = await snapshotEditorPage(page);
  return {
    ...snapshot,
    path: opts.path,
    url: currentUrl,
  };
}

async function waitForEditorContent(page: Page, timeoutMs: number): Promise<void> {
  await page.locator('body').waitFor({ state: 'attached', timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForTimeout(500);
}

async function scrollForLazyContent(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  }).catch(() => undefined);
}

async function snapshotEditorPage(page: Page): Promise<Omit<ListingEditorPageSnapshot, 'path' | 'url'>> {
  return page.evaluate(
    ({ maxTextLength, maxFieldLength, maxFields, maxLinks }) => {
      const truncate = (value: string | null | undefined, max: number): string | undefined => {
        const clean = (value ?? '').replace(/\u00a0|\u202f/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
        if (!clean) return undefined;
        return clean.length > max ? clean.slice(0, max) : clean;
      };

      const visibleText = (el: Element | null): string | undefined => {
        if (!el) return undefined;
        return truncate((el as HTMLElement).innerText ?? el.textContent ?? '', maxFieldLength);
      };

      const labelFor = (el: Element): string | undefined => {
        const id = el.getAttribute('id');
        if (id) {
          const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          const explicitText = visibleText(explicit);
          if (explicitText) return explicitText;
        }
        const aria = el.getAttribute('aria-label');
        if (aria) return truncate(aria, maxFieldLength);
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const label = labelledBy
            .split(/\s+/)
            .map((part) => visibleText(document.getElementById(part)))
            .filter(Boolean)
            .join(' ');
          if (label) return truncate(label, maxFieldLength);
        }
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return truncate(placeholder, maxFieldLength);
        const closestLabel = el.closest('label');
        const closestText = visibleText(closestLabel);
        if (closestText) return closestText;
        const role = el.getAttribute('role');
        const text = role === 'checkbox' || role === 'switch' || role === 'button'
          ? visibleText(el)
          : undefined;
        return text || truncate(el.getAttribute('name'), maxFieldLength);
      };

      const valueFor = (el: Element): string | undefined => {
        if (el instanceof HTMLTextAreaElement) return truncate(el.value, maxFieldLength);
        if (el instanceof HTMLSelectElement) return truncate(el.value, maxFieldLength);
        if (el instanceof HTMLInputElement) {
          if (el.type === 'checkbox' || el.type === 'radio') return truncate(el.value, maxFieldLength);
          return truncate(el.value, maxFieldLength);
        }
        if ((el as HTMLElement).isContentEditable) return visibleText(el);
        return undefined;
      };

      const checkedFor = (el: Element): boolean | undefined => {
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
        const ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;
        const ariaPressed = el.getAttribute('aria-pressed');
        if (ariaPressed === 'true') return true;
        if (ariaPressed === 'false') return false;
        return undefined;
      };

      const selectedTextFor = (el: Element): string | undefined => {
        if (el instanceof HTMLSelectElement) {
          return truncate(el.selectedOptions?.[0]?.textContent, maxFieldLength);
        }
        return undefined;
      };

      const fields = Array.from(
        document.querySelectorAll(
          'input, textarea, select, [contenteditable="true"], [role="checkbox"], [role="switch"], [aria-checked], button[aria-pressed], [role="button"][aria-pressed]',
        ),
      )
        .slice(0, maxFields)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? el.getAttribute('role') ?? undefined,
          label: labelFor(el),
          value: valueFor(el),
          checked: checkedFor(el),
          selectedText: selectedTextFor(el),
        }))
        .filter((field) => field.label || field.value || field.checked !== undefined || field.selectedText);

      const links = Array.from(document.querySelectorAll('a[href]'))
        .slice(0, maxLinks)
        .map((el) => {
          const anchor = el as HTMLAnchorElement;
          return {
            text: truncate(anchor.innerText || anchor.textContent || '', maxFieldLength),
            href: truncate(anchor.href, maxFieldLength),
          };
        })
        .filter((link) => link.text || link.href);

      return {
        title: truncate(document.title, maxFieldLength),
        text: truncate(document.body?.innerText ?? '', maxTextLength),
        fields,
        links,
      };
    },
    {
      maxTextLength: MAX_TEXT_LENGTH,
      maxFieldLength: MAX_FIELD_LENGTH,
      maxFields: MAX_FIELDS,
      maxLinks: MAX_LINKS,
    },
  );
}

function reasonFromError(err: unknown): string {
  if (err instanceof ListingEditorScrapeError) return err.code;
  if (err instanceof Error) {
    if (/Timeout/i.test(err.message)) return 'timeout';
    if (err.message === 'invalid_listing_id' || err.message === 'invalid_editor_path') return err.message;
    return err.message.slice(0, 120);
  }
  return 'unknown_error';
}

export const __listingEditorScraperTestHooks = {
  LISTING_EDITOR_PATHS,
  extractEditorListingId,
  normalizeListingId,
  normalizeRequestedPaths,
};
