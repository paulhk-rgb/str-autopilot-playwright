/**
 * Direct-thread Airbnb message sending.
 *
 * This is intentionally narrower than the old GAS sender: no inbox search, no
 * calendar fallback, and no Enter-key send fallback. Callers must provide the
 * persisted Airbnb thread id and enough identity evidence to verify the loaded
 * page before any text is typed.
 */

import type { BrowserContext, Page } from 'playwright';
import { openPage } from './browser';

export interface SendAirbnbMessageInput {
  conversation_airbnb_id: string;
  guest_name: string;
  message: string;
  check_in?: string | null;
  check_out?: string | null;
  confirmation_code?: string | null;
  property_name?: string | null;
}

export type SendAirbnbMessageResult =
  | { status: 'confirmed' }
  | { status: 'failed'; error: SendMessageErrorCode; clicked_send: false }
  | { status: 'submitted_unconfirmed'; error: SendMessageErrorCode; clicked_send: true };

export type SendMessageErrorCode =
  | 'navigation_failed'
  | 'thread_url_mismatch'
  | 'compose_bar_missing'
  | 'identity_mismatch'
  | 'typing_failed'
  | 'send_button_missing'
  | 'send_button_disabled'
  | 'send_click_failed'
  | 'verification_failed_after_click'
  | 'unexpected_pre_click_error';

const AIRBNB_MESSAGES_URL = 'https://www.airbnb.com/hosting/messages';
const COMPOSE_SELECTOR = '[data-testid="messaging-composebar"]';
const SEND_BUTTON_SELECTOR = '[data-testid="messaging_compose_bar_send_button"]';
const MESSAGE_LIST_SELECTOR = '[data-testid="message-list"]';
const THREAD_NAV_TIMEOUT_MS = 25_000;
const COMPOSE_READY_TIMEOUT_MS = 20_000;
const POST_CLICK_VERIFY_TIMEOUT_MS = 8_000;

const MONTHS = [
  ['jan', 'january'],
  ['feb', 'february'],
  ['mar', 'march'],
  ['apr', 'april'],
  ['may'],
  ['jun', 'june'],
  ['jul', 'july'],
  ['aug', 'august'],
  ['sep', 'sept', 'september'],
  ['oct', 'october'],
  ['nov', 'november'],
  ['dec', 'december'],
] as const;

export async function sendAirbnbMessage(
  ctx: BrowserContext,
  input: SendAirbnbMessageInput,
): Promise<SendAirbnbMessageResult> {
  const page = await openPage(ctx);
  let clickedSend = false;

  try {
    const threadUrl = `${AIRBNB_MESSAGES_URL}/${encodeURIComponent(input.conversation_airbnb_id)}`;
    try {
      await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: THREAD_NAV_TIMEOUT_MS });
    } catch {
      return { status: 'failed', error: 'navigation_failed', clicked_send: false };
    }

    const loadedThreadId = threadIdFromUrl(page.url());
    if (loadedThreadId !== input.conversation_airbnb_id) {
      return { status: 'failed', error: 'thread_url_mismatch', clicked_send: false };
    }

    const compose = page.locator(COMPOSE_SELECTOR).first();
    try {
      await compose.waitFor({ state: 'visible', timeout: COMPOSE_READY_TIMEOUT_MS });
    } catch {
      return { status: 'failed', error: 'compose_bar_missing', clicked_send: false };
    }

    const threadEvidenceText = await readThreadEvidenceText(page);
    if (!canTrustMessageThread(input, threadEvidenceText)) {
      return { status: 'failed', error: 'identity_mismatch', clicked_send: false };
    }

    const matchesBefore = await countMatchingMessages(page, input.message);
    const typed = await typeIntoCompose(page, input.message);
    if (!typed) {
      return { status: 'failed', error: 'typing_failed', clicked_send: false };
    }

    const sendButton = page.locator(SEND_BUTTON_SELECTOR).first();
    const buttonVisible = await sendButton.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!buttonVisible) {
      return { status: 'failed', error: 'send_button_missing', clicked_send: false };
    }
    const buttonEnabled = await sendButton.isEnabled({ timeout: 2_000 }).catch(() => false);
    if (!buttonEnabled) {
      return { status: 'failed', error: 'send_button_disabled', clicked_send: false };
    }

    try {
      await sendButton.click({ timeout: 5_000 });
      clickedSend = true;
    } catch {
      return { status: 'failed', error: 'send_click_failed', clicked_send: false };
    }

    const verified = await waitForSendVerification(
      page,
      input.message,
      matchesBefore,
      input.conversation_airbnb_id,
    );
    if (verified) {
      return { status: 'confirmed' };
    }

    return {
      status: 'submitted_unconfirmed',
      error: 'verification_failed_after_click',
      clicked_send: true,
    };
  } catch {
    if (clickedSend) {
      return {
        status: 'submitted_unconfirmed',
        error: 'verification_failed_after_click',
        clicked_send: true,
      };
    }
    return { status: 'failed', error: 'unexpected_pre_click_error', clicked_send: false };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function readThreadEvidenceText(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const selectors = [
        '[data-testid="messaging-thread-header"]',
        '[data-testid="message-list"]',
        '[role="main"] [data-testid*="reservation"]',
        '[role="main"] [data-testid*="thread"]',
      ];
      const chunks: string[] = [];
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          const text = (node as HTMLElement).innerText || node.textContent || '';
          if (text.trim()) chunks.push(text.trim());
        }
      }
      return chunks.join('\n');
    })
    .catch(() => '');
}

function threadIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\/hosting\/messages\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(guestName: string): string[] {
  return normalizeForMatch(guestName)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function containsFirstName(pageText: string, guestName: string): boolean {
  const [firstName] = nameTokens(guestName);
  if (!firstName) return false;
  return new RegExp(`(?:^| )${escapeRegExp(firstName)}(?: |$)`).test(normalizeForMatch(pageText));
}

function hasContextEvidence(input: SendAirbnbMessageInput, pageText: string): boolean {
  const normalizedPage = normalizeForMatch(pageText);
  const confirmationCode = input.confirmation_code?.trim();
  if (confirmationCode && normalizedPage.includes(normalizeForMatch(confirmationCode))) {
    return true;
  }

  if (input.property_name && propertyMatches(input.property_name, pageText)) {
    return true;
  }

  const checkInMatches = input.check_in ? dateAppearsOnPage(input.check_in, pageText) : false;
  const checkOutMatches = input.check_out ? dateAppearsOnPage(input.check_out, pageText) : false;
  return checkInMatches || checkOutMatches;
}

export function canTrustMessageThread(input: SendAirbnbMessageInput, pageText: string): boolean {
  if (!containsFirstName(pageText, input.guest_name)) {
    return false;
  }

  return hasContextEvidence(input, pageText);
}

function propertyMatches(propertyName: string, pageText: string): boolean {
  const propertyTokens = Array.from(
    new Set(
      normalizeForMatch(propertyName)
        .split(' ')
        .filter((token) => token.length >= 3 && !['the', 'and', 'unit', 'from'].includes(token)),
    ),
  );
  if (propertyTokens.length === 0) return false;

  const pageTokens = new Set(normalizeForMatch(pageText).split(' ').filter(Boolean));
  const matched = propertyTokens.filter((token) => pageTokens.has(token)).length;
  const threshold = Math.min(propertyTokens.length, Math.max(2, Math.ceil(propertyTokens.length * 0.6)));
  return matched >= threshold;
}

function dateAppearsOnPage(isoDate: string, pageText: string): boolean {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const names = MONTHS[monthIndex];
  if (!names || !day) return false;

  const normalizedPage = normalizeForMatch(pageText);
  return names.some((month) => {
    const normalizedMonth = normalizeForMatch(month);
    const dayPattern = `0?${day}`;
    return (
      new RegExp(`(?:^| )${normalizedMonth} ${dayPattern}(?: |$)`).test(normalizedPage) ||
      new RegExp(`(?:^| )${dayPattern} ${normalizedMonth}(?: |$)`).test(normalizedPage)
    );
  });
}

async function typeIntoCompose(page: Page, message: string): Promise<boolean> {
  const compose = composeEditorLocator(page);
  await compose.click({ timeout: 5_000 });

  const initialText = await compose.innerText({ timeout: 3_000 }).catch(() => null);
  if (initialText === null) {
    return false;
  }
  if (hasMeaningfulComposeText(initialText)) {
    return false;
  }

  const lines = message.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      await page.keyboard.type(lines[i], { delay: 5 });
    }
    if (i < lines.length - 1) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    }
  }

  const typedText = await compose.innerText({ timeout: 3_000 }).catch(() => '');
  if (composeTextMatchesMessage(typedText, message)) {
    return true;
  }
  return false;
}

function hasMeaningfulComposeText(composeText: string): boolean {
  if (normalizeForMatch(composeText).length > 0) return true;
  return composeText.replace(/\s+/g, '').length > 0;
}

function composeTextMatchesMessage(composeText: string, message: string): boolean {
  const normalizedCompose = normalizeForMatch(composeText);
  const normalizedMessage = normalizeForMatch(message);
  if (normalizedCompose && normalizedMessage) {
    return normalizedCompose.includes(normalizedMessage);
  }

  const rawCompose = composeText.replace(/\s+/g, ' ').trim();
  const rawMessage = message.replace(/\s+/g, ' ').trim();
  if (!rawCompose || !rawMessage) return false;
  return rawCompose.includes(rawMessage);
}

async function countMatchingMessages(page: Page, message: string): Promise<number> {
  const fingerprint = messageFingerprint(message);
  if (!fingerprint) return 0;

  return page
    .locator(MESSAGE_LIST_SELECTOR)
    .evaluate((list, fp) => {
      const normalize = (value: string) =>
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const normalizedFingerprint = normalize(fp);
      const nodes = Array.from(
        list.querySelectorAll(':scope > div[role="group"], [data-testid*="message-bubble"]'),
      );
      const candidates = nodes.length > 0 ? nodes : Array.from(list.querySelectorAll('[role="group"]'));
      return candidates.filter((el) =>
        normalize(el.textContent || el.getAttribute('aria-label') || '').includes(normalizedFingerprint),
      ).length;
    }, fingerprint)
    .catch(() => 0);
}

async function waitForSendVerification(
  page: Page,
  message: string,
  matchesBefore: number,
  expectedThreadId: string,
): Promise<boolean> {
  await page.waitForTimeout(2_000);
  const reloaded = await page.reload({ waitUntil: 'domcontentloaded', timeout: THREAD_NAV_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!reloaded) {
    return false;
  }
  if (threadIdFromUrl(page.url()) !== expectedThreadId) {
    return false;
  }
  await page.locator(MESSAGE_LIST_SELECTOR).first().waitFor({ state: 'visible', timeout: POST_CLICK_VERIFY_TIMEOUT_MS }).catch(
    () => undefined,
  );
  const matchesAfterReload = await countMatchingMessages(page, message);
  return matchesAfterReload > matchesBefore;
}

function composeEditorLocator(page: Page) {
  return page.locator(`${COMPOSE_SELECTOR}[contenteditable="true"], ${COMPOSE_SELECTOR} [contenteditable="true"]`).first();
}

function messageFingerprint(message: string): string {
  return normalizeForMatch(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __sendMessageTestHooks = {
  canTrustMessageThread,
  composeTextMatchesMessage,
  dateAppearsOnPage,
  hasMeaningfulComposeText,
  messageFingerprint,
  normalizeForMatch,
  propertyMatches,
  threadIdFromUrl,
};
