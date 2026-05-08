/// <reference lib="dom" />
/**
 * Airbnb review-detail scraper for /scrape-review.
 *
 * V1 is intentionally direct-anchor only: review_url or confirmation_code.
 * We do not search the general reviews list because repeat guests/common names
 * make list-search a wrong-stay write risk.
 */

import type { BrowserContext } from 'playwright';

export interface ReviewRatings {
  cleanliness?: number;
  accuracy?: number;
  communication?: number;
  location?: number;
  checkin?: number;
  value?: number;
}

export interface ScrapeReviewOptions {
  guest_name: string;
  review_url?: string | null;
  confirmation_code?: string | null;
  property_name?: string | null;
}

export interface ScrapedReviewText {
  schema_version: 1;
  scraped_at: string;
  review_text: string;
  private_comment: string | null;
  has_public_response: boolean;
  per_category_ratings: ReviewRatings | null;
  source_url: string;
}

const REVIEW_DETAIL_BASE = 'https://www.airbnb.com/progress/reviews/details';
const AIRBNB_URL_RE = /^https?:\/\/(?:www\.)?airbnb\.com(?::\d+)?\//i;
const REVIEW_DETAIL_PATH_RE = /^\/progress\/reviews\/details\/[^/?#]+/i;
const CONF_CODE_RE = /^HM[A-Z0-9-]{6,}$/i;
const MIN_PUBLIC_REVIEW_LENGTH = 3;
const SENTINEL_GUEST_NAMES = new Set([
  'airbnb guest',
  'airbnb user',
  'guest',
  'redacted',
  'unknown guest',
]);

export class ScrapeReviewError extends Error {
  constructor(
    public readonly code:
      | 'malformed_body'
      | 'invalid_review_url'
      | 'invalid_confirmation_code'
      | 'sentinel_guest_name'
      | 'invalid_cookies'
      | 'review_not_found'
      | 'reservation_not_found'
      | 'identity_mismatch'
      | 'no_text',
    message = code,
  ) {
    super(message);
    this.name = 'ScrapeReviewError';
  }
}

export function isValidAirbnbReviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return AIRBNB_URL_RE.test(url.toString()) && REVIEW_DETAIL_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

export function normalizeGuestIdentity(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSentinelGuestName(value: string): boolean {
  const normalized = normalizeGuestIdentity(value);
  return !normalized || SENTINEL_GUEST_NAMES.has(normalized);
}

function reviewUrlFor(opts: ScrapeReviewOptions): string {
  if (opts.review_url) {
    if (!isValidAirbnbReviewUrl(opts.review_url)) {
      throw new ScrapeReviewError('invalid_review_url');
    }
    return opts.review_url;
  }
  const confCode = opts.confirmation_code?.trim().toUpperCase();
  if (!confCode || !CONF_CODE_RE.test(confCode)) {
    throw new ScrapeReviewError('invalid_confirmation_code');
  }
  return `${REVIEW_DETAIL_BASE}/${encodeURIComponent(confCode)}`;
}

function identityMatches(guestName: string, dialogText: string): boolean {
  const normalizedGuest = normalizeGuestIdentity(guestName);
  if (!normalizedGuest || SENTINEL_GUEST_NAMES.has(normalizedGuest)) return false;
  const tokens = normalizedGuest.split(' ').filter((token) => token.length >= 2);
  if (tokens.length === 0) return false;

  const normalizedDialog = normalizeGuestIdentity(dialogText);
  if (!normalizedDialog) return false;

  // The Airbnb detail heading often renders "Alice's group of 3", so the first
  // token is the stable belt-and-suspenders check while the confirmation/detail
  // URL is the true anchor.
  return normalizedDialog.split(' ').includes(tokens[0]);
}

function isWeakGuestIdentity(value: string): boolean {
  const normalized = normalizeGuestIdentity(value);
  if (!normalized || SENTINEL_GUEST_NAMES.has(normalized)) return true;
  if (normalized === 'a recent guest' || normalized === 'recent guest') return true;
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => token.length <= 2);
}

function propertyMatches(propertyName: string | null | undefined, dialogText: string): boolean {
  const normalizedProperty = normalizeGuestIdentity(propertyName ?? '');
  if (!normalizedProperty) return false;
  const normalizedDialog = normalizeGuestIdentity(dialogText);
  if (!normalizedDialog) return false;
  if (normalizedDialog.includes(normalizedProperty)) return true;

  const propertyTokens = normalizedProperty
    .split(' ')
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  if (propertyTokens.length === 0) return false;
  const dialogTokens = new Set(normalizedDialog.split(' '));
  const matched = propertyTokens.filter((token) => dialogTokens.has(token)).length;
  const required = Math.min(3, Math.max(1, Math.ceil(propertyTokens.length * 0.45)));
  return matched >= required;
}

function canTrustDirectReviewUrl(opts: ScrapeReviewOptions): boolean {
  return Boolean(opts.review_url && isValidAirbnbReviewUrl(opts.review_url));
}

function canTrustGuestIdentity(opts: ScrapeReviewOptions, dialogText: string): boolean {
  if (!identityMatches(opts.guest_name, dialogText)) return false;
  if (!opts.property_name) return true;
  return propertyMatches(opts.property_name, dialogText);
}

function canTrustReviewSource(opts: ScrapeReviewOptions, dialogText: string): boolean {
  if (canTrustGuestIdentity(opts, dialogText)) return true;
  if (
    canTrustDirectReviewUrl(opts) &&
    !isWeakGuestIdentity(opts.guest_name) &&
    identityMatches(opts.guest_name, dialogText) &&
    (!opts.property_name || propertyMatches(opts.property_name, dialogText))
  ) {
    return true;
  }
  if (!canTrustDirectReviewUrl(opts) || !isWeakGuestIdentity(opts.guest_name)) return false;
  return opts.property_name ? propertyMatches(opts.property_name, dialogText) : true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function missingAnchorError(opts: ScrapeReviewOptions): ScrapeReviewError {
  return new ScrapeReviewError(opts.review_url ? 'review_not_found' : 'reservation_not_found');
}

export async function scrapeReviewText(
  ctx: BrowserContext,
  opts: ScrapeReviewOptions,
): Promise<ScrapedReviewText> {
  if (isSentinelGuestName(opts.guest_name)) {
    throw new ScrapeReviewError('sentinel_guest_name');
  }

  const targetUrl = reviewUrlFor(opts);
  const page = await ctx.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);

    if (page.url().includes('/login')) {
      throw new ScrapeReviewError('invalid_cookies');
    }

    const detailState = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') ?? document.body;
      const text = dialog?.textContent?.trim() ?? '';
      const hasReviewMarker = /public review|private feedback|detailed rating|write a public reply|edit public reply/i.test(text);
      return { text, hasReviewMarker };
    });

    if (!detailState.hasReviewMarker) {
      throw missingAnchorError(opts);
    }

    if (!canTrustReviewSource(opts, detailState.text)) {
      throw new ScrapeReviewError('identity_mismatch');
    }

    await expandReviewDetailContent(page);

    const extracted = await page.evaluate(() => {
      const result: {
        reviewText: string;
        privateComment: string;
        hasPublicResponse: boolean;
        detailedFeedback: Array<{ category: string; rating: number }>;
      } = {
        reviewText: '',
        privateComment: '',
        hasPublicResponse: false,
        detailedFeedback: [],
      };

      const root = document.querySelector('[role="dialog"]') ?? document.body;
      if (!root) return result;

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes: Array<{ text: string; parentTag: string; inButton: boolean; inLink: boolean }> = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent?.trim() ?? '';
        if (!text) continue;
        const parent = node.parentElement;
        textNodes.push({
          text,
          parentTag: parent?.tagName?.toLowerCase() ?? '',
          inButton: Boolean(parent?.closest('button')),
          inLink: Boolean(parent?.closest('a')),
        });
      }

      let section: 'public' | 'private' | null = null;
      const publicParts: string[] = [];
      const privateParts: string[] = [];
      const appendUnique = (parts: string[], text: string) => {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (!normalized) return;
        const last = parts[parts.length - 1] ?? '';
        if (last === normalized || last.includes(normalized)) return;
        if (normalized.includes(last) && last) {
          parts[parts.length - 1] = normalized;
          return;
        }
        parts.push(normalized);
      };

      for (const item of textNodes) {
        const lower = item.text.toLowerCase();
        if (lower.startsWith('public review')) {
          section = 'public';
          continue;
        }
        if (
          lower.includes('private feedback') ||
          lower.includes('private note') ||
          lower.includes('private comment')
        ) {
          section = 'private';
          continue;
        }
        if (lower === 'edit public reply') {
          result.hasPublicResponse = true;
          section = null;
          continue;
        }
        if (
          lower === 'write a public reply' ||
          lower.startsWith('detailed rating') ||
          lower.startsWith('overall rating') ||
          lower.startsWith('rating') ||
          lower.startsWith('category rating') ||
          lower.startsWith('categories')
        ) {
          section = null;
          continue;
        }
        if (
          lower === 'post' ||
          lower === 'cancel' ||
          lower === 'show more' ||
          lower === 'read more' ||
          lower === 'see more' ||
          item.inButton ||
          item.inLink
        ) {
          continue;
        }
        if (item.text.length < 3) continue;

        if (section === 'public') {
          appendUnique(publicParts, item.text);
          continue;
        }
        if (section === 'private') {
          appendUnique(privateParts, item.text);
          continue;
        }
      }

      result.reviewText = publicParts.join(' ').trim();
      result.privateComment = privateParts.join(' ').trim();

      if (!result.reviewText) {
        const candidates = Array.from(root.querySelectorAll('p, span, div'))
          .map((el) => ({
            text: el.textContent?.trim() ?? '',
            inButton: Boolean(el.closest('button')),
            inLink: Boolean(el.closest('a')),
          }))
          .filter((candidate) => {
            const lower = candidate.text.toLowerCase();
            return candidate.text.length >= 15 &&
              !candidate.inButton &&
              !candidate.inLink &&
              !/public review|private feedback|detailed rating|write a public|edit public|night|checkout|check-in/i.test(lower);
          })
          .sort((a, b) => b.text.length - a.text.length);
        result.reviewText = candidates[0]?.text ?? '';
      }

      const allText = root.textContent ?? '';
      const categories: Array<['checkin' | 'cleanliness' | 'accuracy' | 'communication' | 'location' | 'value', string]> = [
        ['checkin', 'Check-in'],
        ['cleanliness', 'Cleanliness'],
        ['accuracy', 'Accuracy'],
        ['communication', 'Communication'],
        ['location', 'Location'],
        ['value', 'Value'],
      ];
      const categoryMap = {
        checkin: 'checkin',
        cleanliness: 'cleanliness',
        accuracy: 'accuracy',
        communication: 'communication',
        location: 'location',
        value: 'value',
      };
      for (const [category, label] of categories) {
        const match = allText.match(new RegExp(`${label}[\\s\\S]{0,50}?(\\d)\\s*(?:★|star)`, 'i'));
        const rating = match?.[1] ? Number(match[1]) : null;
        if (rating && rating >= 1 && rating <= 5) {
          result.detailedFeedback.push({ category: categoryMap[category], rating });
        }
      }

      return result;
    });

    const reviewText = extracted.reviewText.trim();
    if (reviewText.length < MIN_PUBLIC_REVIEW_LENGTH) {
      throw new ScrapeReviewError('no_text');
    }

    const ratings: ReviewRatings = {};
    for (const item of extracted.detailedFeedback) {
      if (
        item.category === 'cleanliness' ||
        item.category === 'accuracy' ||
        item.category === 'communication' ||
        item.category === 'location' ||
        item.category === 'checkin' ||
        item.category === 'value'
      ) {
        ratings[item.category] = item.rating;
      }
    }

    return {
      schema_version: 1,
      scraped_at: new Date().toISOString(),
      review_text: reviewText,
      private_comment: extracted.privateComment.trim() || null,
      has_public_response: extracted.hasPublicResponse,
      per_category_ratings: Object.keys(ratings).length > 0 ? ratings : null,
      source_url: page.url(),
    };
  } catch (err) {
    if (err instanceof ScrapeReviewError) throw err;
    throw new Error(`scrape_review_failed: ${errorMessage(err)}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function expandReviewDetailContent(page: { evaluate: <T>(fn: () => T) => Promise<T>; waitForTimeout: (ms: number) => Promise<void> }): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]') ?? document.body;
      if (!root) return false;
      const controls = Array.from(root.querySelectorAll('button, [role="button"]'));
      for (const control of controls) {
        const text = `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!text) continue;
        if (
          text === 'show more' ||
          text === 'read more' ||
          text === 'see more' ||
          /^show (more|all|full)/.test(text) ||
          /^read (more|all|full)/.test(text) ||
          /^see (more|all|full)/.test(text)
        ) {
          if (control instanceof HTMLElement) {
            control.click();
            return true;
          }
        }
      }
      return false;
    });

    if (!clicked) return;
    await page.waitForTimeout(500);
  }
}

export const __scrapeReviewTestHooks = {
  CONF_CODE_RE,
  canTrustGuestIdentity,
  canTrustReviewSource,
  canTrustDirectReviewUrl,
  identityMatches,
  isWeakGuestIdentity,
  isSentinelGuestName,
  isValidAirbnbReviewUrl,
  normalizeGuestIdentity,
  propertyMatches,
  reviewUrlFor,
  expandReviewDetailContent,
};
