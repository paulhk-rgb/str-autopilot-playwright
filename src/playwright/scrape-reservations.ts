/**
 * Reservation-list scraper for /scrape-reservation-list.
 *
 * Airbnb booking inventory is the source of truth for current/future action.
 * This reader therefore fails closed: an empty result is only successful when
 * the page exposes an explicit empty-state signal. If Airbnb changes the page
 * or API shape and we cannot identify rows, callers get a scrape error rather
 * than a false green "0 reservations" audit.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BrowserContext, Page, Response as PlaywrightResponse } from 'playwright';
import type { Reservation } from '../endpoints/scrape-reservation-list';

export interface ScrapeReservationsOptions {
  mode: 'initial' | 'incremental' | 'full';
  window_start: string;
  window_end: string;
  cursor: string | null;
  apiKey?: string | null;
  cursorSecret: string;
}

export interface ScrapeReservationsResult {
  schema_version: 3;
  mode: 'initial' | 'incremental' | 'full';
  window_start: string;
  window_end: string;
  page_cursor: string | null;
  next_page_cursor: string | null;
  page_index: number;
  is_complete: boolean;
  scraped_at: string;
  reservations: Reservation[];
  diagnostics: Record<string, unknown>;
}

interface JsonCandidate {
  value: unknown;
  sourceUrl: string;
  status: number;
  requestHeaders: Record<string, string>;
}

interface JsonCandidateDiagnostic {
  sourcePath: string;
  topKeys: string[];
  reservationsCount: number | null;
  errorCode: string | null;
}

interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  anchors: Array<{ href: string; text: string; cardText: string }>;
}

const RESERVATIONS_URL = 'https://www.airbnb.com/hosting/reservations/all';
const RESERVATION_DETAILS_URL = 'https://www.airbnb.com/hosting/reservations/details';
const RESERVATIONS_API_PATH = '/api/v2/reservations';
const RESERVATIONS_API_LIMIT = 40;
const RESERVATIONS_API_STATUS = 'accepted,request,canceled';
const RESERVATIONS_API_MAX_ATTEMPTS = 3;
const RESERVATIONS_API_RETRY_BASE_MS = 750;
const CONF_CODE_RE = /^(?=.*[a-z])(?=.*\d)[a-z0-9-]{6,}$/i;
const CURSOR_VERSION = 'rsv-v1';

export class ReservationListCursorError extends Error {
  constructor(message = 'reservation_list_cursor_invalid') {
    super(message);
    this.name = 'ReservationListCursorError';
  }
}

interface ReservationListCursorPayload {
  v: 1;
  mode: 'initial' | 'incremental' | 'full';
  window_start: string;
  window_end: string;
  offset: number;
  page_index: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isReservationListApiAuthError(err: unknown): boolean {
  return /^reservation_list_api_auth_failed:(401|403)$/.test(errorMessage(err));
}

function pageBudget(mode: ScrapeReservationsOptions['mode']): number {
  switch (mode) {
    case 'full':
      return 1000;
    case 'initial':
      return 40;
    case 'incremental':
    default:
      return 20;
  }
}

function normalizeDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) return formatDate(Number(slash[3]), Number(slash[1]), Number(slash[2]));
    const monthName = trimmed.match(
      /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})$/i,
    );
    if (monthName) {
      const month = monthNumber(monthName[1]);
      if (month !== null) return formatDate(Number(monthName[3]), month, Number(monthName[2]));
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const year = numberish(obj.year);
    const month = numberish(obj.month);
    const day = numberish(obj.day);
    if (year && month && day) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

function formatDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function monthNumber(value: string): number | null {
  return MONTHS[value.toLowerCase()] ?? null;
}

function numberish(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = normalizeNumberString(value);
    if (!cleaned) return null;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeNumberString(value: string): string | null {
  let cleaned = value.replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const commaDecimal = /,\d{1,2}$/.test(cleaned);
    cleaned = commaDecimal ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  }
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
}

function textish(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function idish(value: unknown): string | null {
  const text = textish(value);
  if (text) return text;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function deepGet(obj: Record<string, unknown>, paths: string[][]): unknown {
  for (const path of paths) {
    let cursor: unknown = obj;
    for (const key of path) {
      if (!cursor || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor !== undefined && cursor !== null) return cursor;
  }
  return undefined;
}

function extractReservationFromObject(obj: Record<string, unknown>): Reservation | null {
  const confRaw = deepGet(obj, [
    ['confirmationCode'],
    ['confirmation_code'],
    ['confirmation'],
    ['confCode'],
    ['conf_code'],
    ['reservationCode'],
    ['reservation_code'],
  ]);
  const confCode = textish(confRaw)?.toUpperCase() ?? null;
  if (!confCode || !CONF_CODE_RE.test(confCode)) return null;

  const guestName =
    textish(deepGet(obj, [
      ['guestName'],
      ['guest_name'],
      ['guest', 'name'],
      ['guest', 'fullName'],
      ['guest_user', 'full_name'],
      ['guest_user', 'first_name'],
    ])) ??
    buildGuestName(deepGet(obj, [['guest']]));
  const checkIn = normalizeDate(
    deepGet(obj, [
      ['checkIn'],
      ['check_in'],
      ['start_date'],
      ['checkinDate'],
      ['startDate'],
      ['start'],
      ['arrivalDate'],
    ]),
  );
  const checkOut = normalizeDate(
    deepGet(obj, [
      ['checkOut'],
      ['check_out'],
      ['end_date'],
      ['checkoutDate'],
      ['endDate'],
      ['end'],
      ['departureDate'],
    ]),
  );
  if (!guestName || !checkIn || !checkOut || checkOut <= checkIn) return null;

  const listingId =
    idish(deepGet(obj, [['listingId'], ['listing_id_str'], ['listing_id'], ['listing', 'id'], ['space', 'id']])) ??
    null;
  const listingName =
    textish(deepGet(obj, [['listingName'], ['listing_name'], ['listing', 'name'], ['space', 'name']])) ??
    null;
  const statusText =
    textish(
      deepGet(obj, [
        ['statusText'],
        ['status_text'],
        ['status'],
        ['reservationStatus'],
        ['reservation_status'],
        ['user_facing_status_localized'],
        ['user_facing_status_key'],
        ['host_calendar_reservation_status'],
      ]),
    ) ?? null;
  const reservationUrl = textish(
    deepGet(obj, [['reservationUrl'], ['reservation_url'], ['url']]),
  );
  const payout = numberish(
    deepGet(obj, [
      ['totalPayout'],
      ['total_payout'],
      ['hostPayout'],
      ['host_payout'],
      ['payout', 'amount'],
      ['earnings'],
    ]),
  );
  const guestPaid = numberish(
    deepGet(obj, [
      ['guestPaid'],
      ['guest_paid'],
      ['totalPrice'],
      ['total_price'],
      ['guestTotal', 'amount'],
    ]),
  );
  if (
    !statusText &&
    !listingId &&
    !listingName &&
    payout === null &&
    guestPaid === null &&
    !reservationUrl?.includes('/reservation')
  ) {
    return null;
  }

  return {
    conf_code: confCode,
    guest_name: guestName,
    check_in: checkIn,
    check_out: checkOut,
    status_text: statusText ?? 'Unknown',
    listing_id: listingId,
    listing_name: listingName,
    guest_count: numberish(
      deepGet(obj, [
        ['guestCount'],
        ['guest_count'],
        ['numberOfGuests'],
        ['guestDetails', 'numberOfGuests'],
        ['guest_details', 'number_of_guests'],
        ['guest_details', 'number_of_adults'],
      ]),
    ),
    total_payout: payout,
    guest_paid: guestPaid,
    reservation_url: reservationUrl ?? `${RESERVATION_DETAILS_URL}/${confCode}`,
    conversation_airbnb_id:
      idish(
        deepGet(obj, [
          ['conversationAirbnbId'],
          ['conversation_airbnb_id'],
          ['threadId'],
          ['thread_id'],
          ['messageThreadId'],
          ['bessie_thread_id'],
        ]),
      ) ?? null,
  };
}

function buildGuestName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const parts = [textish(obj.firstName), textish(obj.lastName)].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function collectJsonReservations(value: unknown, sourceUrl = 'unknown'): Reservation[] {
  const out: Reservation[] = [];
  const seen = new Set<unknown>();

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const obj = node as Record<string, unknown>;
    const reservation = extractReservationFromObject(obj);
    if (reservation) {
      out.push({
        ...reservation,
        reservation_url: reservation.reservation_url ?? sourceUrl,
      });
    }
    for (const child of Object.values(obj)) walk(child);
  }

  walk(value);
  return out;
}

function jsonCandidateDiagnostic(candidate: JsonCandidate): JsonCandidateDiagnostic {
  let sourcePath = candidate.sourceUrl;
  try {
    const parsed = new URL(candidate.sourceUrl);
    sourcePath = `${parsed.origin}${parsed.pathname}`;
  } catch {
    sourcePath = candidate.sourceUrl.split('?')[0] ?? candidate.sourceUrl;
  }
  const value = candidate.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      sourcePath,
      topKeys: [],
      reservationsCount: null,
      errorCode: null,
    };
  }
  const obj = value as Record<string, unknown>;
  return {
    sourcePath,
    topKeys: Object.keys(obj).slice(0, 20),
    reservationsCount: Array.isArray(obj.reservations) ? obj.reservations.length : null,
    errorCode: textish(obj.error_code) ?? textish(obj.error) ?? null,
  };
}

function mergeReservations(reservations: Reservation[]): Reservation[] {
  const byCode = new Map<string, Reservation>();
  for (const reservation of reservations) {
    const existing = byCode.get(reservation.conf_code);
    if (!existing) {
      byCode.set(reservation.conf_code, reservation);
      continue;
    }
    const incomingStatusRank = statusRank(reservation.status_text);
    const existingStatusRank = statusRank(existing.status_text);
    byCode.set(reservation.conf_code, {
      ...existing,
      ...Object.fromEntries(
        Object.entries(reservation).filter(([key, value]) => {
          if (value === null || value === undefined || value === '') return false;
          if (key === 'status_text') {
            return incomingStatusRank >= existingStatusRank;
          }
          if (!shouldMergeReservationValue(key, value, existing, incomingStatusRank, existingStatusRank)) return false;
          return true;
        }),
      ),
    } as Reservation);
  }
  return Array.from(byCode.values()).sort((a, b) =>
    `${a.check_in}:${a.conf_code}`.localeCompare(`${b.check_in}:${b.conf_code}`),
  );
}

function shouldMergeReservationValue(
  key: string,
  incomingValue: unknown,
  existing: Reservation,
  incomingStatusRank: number,
  existingStatusRank: number,
): boolean {
  const existingValue = existing[key as keyof Reservation];
  if (existingValue === null || existingValue === undefined || existingValue === '') return true;
  if (incomingStatusRank < existingStatusRank) return false;
  if (
    typeof incomingValue === 'number' &&
    typeof existingValue === 'number' &&
    incomingValue === 0 &&
    existingValue > 0 &&
    incomingStatusRank <= existingStatusRank
  ) {
    return false;
  }
  if (
    (key === 'guest_name' || key === 'listing_name' || key === 'reservation_url' || key === 'conversation_airbnb_id') &&
    typeof incomingValue === 'string' &&
    typeof existingValue === 'string' &&
    incomingValue.length < existingValue.length
  ) {
    return false;
  }
  return true;
}

function statusRank(status: string | null | undefined): number {
  const normalized = status?.toLowerCase() ?? '';
  if (normalized.includes('cancel')) return 5;
  if (
    normalized.includes('confirmed') ||
    normalized.includes('accepted') ||
    normalized.includes('completed')
  ) {
    return 4;
  }
  if (normalized.includes('awaiting') || normalized.includes('pending')) return 3;
  if (normalized && normalized !== 'unknown') return 2;
  return 1;
}

function filterByWindow(
  reservations: Reservation[],
  windowStart: string,
  windowEnd: string,
): Reservation[] {
  return reservations.filter(
    (reservation) => reservation.check_out >= windowStart && reservation.check_in <= windowEnd,
  );
}

async function collectJsonCandidates(page: Page, action: () => Promise<void>): Promise<JsonCandidate[]> {
  const candidates: JsonCandidate[] = [];
  const listener = async (response: PlaywrightResponse) => {
    const url = response.url();
    const lower = url.toLowerCase();
    if (
      !lower.includes('/api/') &&
      !lower.includes('graphql') &&
      !lower.includes('reservation') &&
      !lower.includes('hosting')
    ) {
      return;
    }
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('json')) return;
    try {
      candidates.push({
        value: await response.json(),
        sourceUrl: url,
        status: response.status(),
        requestHeaders: response.request().headers(),
      });
    } catch {
      // Ignore non-readable or already-consumed bodies.
    }
  };
  page.on('response', listener);
  try {
    await action();
  } finally {
    page.off('response', listener);
  }
  return candidates;
}

function isReservationsApiUrl(url: string): boolean {
  try {
    return new URL(url).pathname === RESERVATIONS_API_PATH;
  } catch {
    return false;
  }
}

function reservationsApiUrl(offset: number, limit = RESERVATIONS_API_LIMIT): string {
  return [
    'https://www.airbnb.com',
    RESERVATIONS_API_PATH,
    '?locale=en',
    '&currency=USD',
    '&_format=for_remy',
    `&_limit=${limit}`,
    `&_offset=${offset}`,
    '&collection_strategy=for_reservations_list',
    '&sort_field=start_date',
    '&sort_order=desc',
    // Keep the comma literal to match Airbnb's own SPA request shape.
    `&status=${RESERVATIONS_API_STATUS}`,
  ].join('');
}

function apiHeadersFromBootstrap(
  candidate: JsonCandidate,
  apiKey: string | null | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(candidate.requestHeaders)) {
    const key = rawKey.toLowerCase();
    if (
      key === 'accept' ||
      key === 'referer' ||
      key === 'x-airbnb-api-key' ||
      key === 'x-airbnb-supports-airlock-v2' ||
      key === 'x-csrf-token' ||
      key === 'x-csrf-without-token' ||
      key === 'x-client-version' ||
      key === 'x-requested-with'
    ) {
      headers[key] = value;
    }
  }
  headers['x-airbnb-api-key'] = headers['x-airbnb-api-key'] ?? apiKey ?? '';
  if (!headers['x-airbnb-api-key']) throw new Error('reservation_list_api_key_missing');
  headers.accept = headers.accept ?? 'application/json, text/javascript, */*; q=0.01';
  headers.referer = headers.referer ?? RESERVATIONS_URL;
  return headers;
}

function defaultReservationsApiHeaders(apiKey: string | null | undefined): Record<string, string> {
  if (!apiKey) throw new Error('reservation_list_api_key_missing');
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    referer: RESERVATIONS_URL,
    'x-airbnb-api-key': apiKey,
  };
}

function reservationApiRows(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const rows = (value as Record<string, unknown>).reservations;
  return Array.isArray(rows) ? rows : [];
}

function reservationApiTotalCount(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = (value as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const total = (metadata as Record<string, unknown>).total_count;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
}

function isRetryableApiStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cursorSignature(payloadB64: string, secretHex: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(payloadB64)
    .digest('base64url')
    .slice(0, 24);
}

function encodeReservationListCursor(
  payload: ReservationListCursorPayload,
  secretHex: string,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${CURSOR_VERSION}.${payloadB64}.${cursorSignature(payloadB64, secretHex)}`;
}

function decodeReservationListCursor(
  cursor: string | null,
  opts: ScrapeReservationsOptions,
): ReservationListCursorPayload {
  if (cursor === null) {
    return {
      v: 1,
      mode: opts.mode,
      window_start: opts.window_start,
      window_end: opts.window_end,
      offset: 0,
      page_index: 0,
    };
  }

  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) {
    throw new ReservationListCursorError();
  }

  const [, payloadB64, signature] = parts;
  const expectedSignature = cursorSignature(payloadB64, opts.cursorSecret);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ReservationListCursorError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new ReservationListCursorError();
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReservationListCursorError();
  }
  const parsed = payload as Partial<ReservationListCursorPayload>;
  const offset = parsed.offset;
  const pageIndex = parsed.page_index;
  const mode = parsed.mode;
  const windowStart = parsed.window_start;
  const windowEnd = parsed.window_end;
  if (
    parsed.v !== 1 ||
    (mode !== 'initial' && mode !== 'incremental' && mode !== 'full') ||
    typeof windowStart !== 'string' ||
    typeof windowEnd !== 'string' ||
    !Number.isInteger(offset) ||
    !Number.isInteger(pageIndex) ||
    typeof offset !== 'number' ||
    typeof pageIndex !== 'number' ||
    offset < RESERVATIONS_API_LIMIT ||
    offset % RESERVATIONS_API_LIMIT !== 0 ||
    pageIndex < 1 ||
    offset / RESERVATIONS_API_LIMIT !== pageIndex
  ) {
    throw new ReservationListCursorError();
  }

  return {
    v: 1,
    mode,
    window_start: windowStart,
    window_end: windowEnd,
    offset,
    page_index: pageIndex,
  };
}

function subtractDaysFromDateOnly(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function maxApiRowCheckIn(rows: unknown[]): string | null {
  let max: string | null = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const date = normalizeDate(
      deepGet(row as Record<string, unknown>, [
        ['checkIn'],
        ['check_in'],
        ['start_date'],
        ['checkinDate'],
        ['startDate'],
        ['start'],
        ['arrivalDate'],
      ]),
    );
    if (date && (max === null || date > max)) max = date;
  }
  return max;
}

async function fetchReservationsApiJson(input: {
  ctx: BrowserContext;
  url: string;
  headers: Record<string, string>;
}): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= RESERVATIONS_API_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await input.ctx.request.get(input.url, {
        headers: input.headers,
        timeout: 30_000,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === RESERVATIONS_API_MAX_ATTEMPTS) throw lastError;
      await sleep(RESERVATIONS_API_RETRY_BASE_MS * attempt);
      continue;
    }
    const status = response.status();
    const text = await response.text();
    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('reservation_list_api_malformed_json');
      }
    }
    if (status === 401 || status === 403) {
      throw new Error(`reservation_list_api_auth_failed:${status}`);
    }
    lastError = new Error(`reservation_list_api_failed:${status}`);
    if (!isRetryableApiStatus(status) || attempt === RESERVATIONS_API_MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleep(RESERVATIONS_API_RETRY_BASE_MS * attempt);
  }
  throw lastError ?? new Error('reservation_list_api_failed:unknown');
}

async function readReservationsViaApi(
  ctx: BrowserContext,
  candidates: JsonCandidate[],
  opts: ScrapeReservationsOptions,
): Promise<{
  reservations: Reservation[];
  totalCount: number | null;
  pageCursor: string | null;
  nextPageCursor: string | null;
  pageIndex: number;
  isComplete: boolean;
  diagnostics: Record<string, unknown>;
} | null> {
  const bootstrap = candidates.find(
    (candidate) =>
      isReservationsApiUrl(candidate.sourceUrl) &&
      candidate.status >= 200 &&
      candidate.status < 300 &&
      Array.isArray((candidate.value as Record<string, unknown> | null)?.reservations),
  );
  if (!bootstrap && !opts.apiKey) return null;

  const headers = bootstrap
    ? apiHeadersFromBootstrap(bootstrap, opts.apiKey)
    : defaultReservationsApiHeaders(opts.apiKey);
  const cursor = decodeReservationListCursor(opts.cursor, opts);
  if (cursor.page_index >= pageBudget(opts.mode)) {
    throw new Error('reservation_list_api_page_budget_exceeded');
  }

  const value = await fetchReservationsApiJson({
    ctx,
    url: reservationsApiUrl(cursor.offset),
    headers,
  });
  const rows = reservationApiRows(value);
  const totalCount = reservationApiTotalCount(value);
  const reservations = collectJsonReservations(value, reservationsApiUrl(cursor.offset));
  const stopBefore = opts.mode === 'full' ? null : subtractDaysFromDateOnly(opts.window_start, 400);
  const maxCheckIn = maxApiRowCheckIn(rows);
  const stoppedByWindowBoundary = Boolean(stopBefore && maxCheckIn && maxCheckIn < stopBefore);
  const nextOffset = cursor.offset + RESERVATIONS_API_LIMIT;
  let hasNextPage = false;

  if (totalCount === 0 && rows.length === 0) {
    hasNextPage = false;
  } else if (totalCount !== null) {
    if (rows.length === 0 && cursor.offset < totalCount) {
      throw new Error('reservation_list_api_empty_page_before_total');
    }
    hasNextPage = nextOffset < totalCount;
  } else {
    hasNextPage = rows.length >= RESERVATIONS_API_LIMIT;
  }

  if (stoppedByWindowBoundary) {
    hasNextPage = false;
  }

  const nextCursor = hasNextPage
    ? encodeReservationListCursor(
        {
          v: 1,
          mode: opts.mode,
          window_start: opts.window_start,
          window_end: opts.window_end,
          offset: nextOffset,
          page_index: cursor.page_index + 1,
        },
        opts.cursorSecret,
      )
    : null;
  return {
    reservations,
    totalCount,
    pageCursor: opts.cursor,
    nextPageCursor: nextCursor,
    pageIndex: cursor.page_index,
    isComplete: nextCursor === null,
    diagnostics: {
      source: 'api',
      api_limit: RESERVATIONS_API_LIMIT,
      api_offset: cursor.offset,
      api_rows: rows.length,
      api_total_count: totalCount,
      max_check_in: maxCheckIn,
      stopped_by_window_boundary: stoppedByWindowBoundary,
    },
  };
}

async function snapshotPage(page: Page): Promise<PageSnapshot> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: any }).document;
    const loc = (globalThis as unknown as { location: any }).location;
    function normalizedText(node: { textContent?: string | null }): string {
      return node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    }
    function nearestCardText(el: {
      closest: (selector: string) => any;
      parentElement?: any;
      textContent?: string | null;
    }): string {
      const selectors = ['tr', 'li', '[role="row"]', '[data-testid*="reservation"]', '[data-testid*="card"]', 'article'];
      for (const selector of selectors) {
        const card = el.closest(selector);
        const text = card ? normalizedText(card) : '';
        if (text.length > 20 && text.length < 1200) return text;
      }
      let parent = el.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1) {
        const text = normalizedText(parent);
        if (text.length > 20 && text.length < 1200) return text;
        parent = parent.parentElement;
      }
      return normalizedText(el).slice(0, 1000);
    }
    const anchors = Array.from(
      doc.querySelectorAll('a[href*="/hosting/reservations/details/"]') as ArrayLike<{
        href: string;
        textContent?: string | null;
        closest: (selector: string) => any;
        parentElement?: any;
      }>,
    ).map((anchor) => ({
      href: anchor.href,
      text: anchor.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      cardText: nearestCardText(anchor),
    }));
    return {
      url: loc.href,
      title: doc.title,
      text: doc.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 5000) ?? '',
      anchors,
    };
  });
}

function extractDateRangeFromText(
  text: string,
  defaultYear = new Date().getUTCFullYear(),
): { checkIn: string; checkOut: string } | null {
  const isoMatches = Array.from(text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)).map((m) => m[1]);
  if (isoMatches.length >= 2) {
    return { checkIn: isoMatches[0], checkOut: isoMatches[1] };
  }
  const range = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\s*(?:-|–|—|to)\s*(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?(\d{1,2})(?:,?\s+(20\d{2}))?\b/i,
  );
  if (!range) return null;
  const startMonth = monthNumber(range[1]);
  const endMonth = monthNumber(range[4] ?? range[1]);
  if (startMonth === null || endMonth === null) return null;
  const explicitStartYear = range[3] ? Number(range[3]) : null;
  const explicitEndYear = range[6] ? Number(range[6]) : null;
  const startYear =
    explicitStartYear ??
    (explicitEndYear !== null && endMonth < startMonth ? explicitEndYear - 1 : explicitEndYear) ??
    defaultYear;
  let endYear = explicitEndYear ?? explicitStartYear ?? defaultYear;
  if (endMonth < startMonth && !range[6]) endYear += 1;
  const checkIn = formatDate(startYear, startMonth, Number(range[2]));
  const checkOut = formatDate(endYear, endMonth, Number(range[5]));
  if (!checkIn || !checkOut || checkOut <= checkIn) return null;
  return { checkIn, checkOut };
}

function parseGuestName(anchorText: string, cardText: string): string | null {
  const compactAnchor = anchorText.trim();
  if (
    compactAnchor &&
    compactAnchor.length <= 80 &&
    !/\b(20\d{2}-\d{2}-\d{2}|confirmed|accepted|cancelled|canceled|pending|completed|awaiting|inquiry|request|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2})\b/i.test(
      compactAnchor,
    )
  ) {
    return compactAnchor;
  }
  const beforeDate = cardText
    .split(/\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}|confirmed|accepted|cancelled|canceled|pending|completed|awaiting|inquiry|request)\b/i)[0]
    .trim()
    .replace(/\b(?:guest|reservation)\b:?/gi, '')
    .trim()
    .slice(0, 120);
  return beforeDate || null;
}

function reservationsFromDom(snapshot: PageSnapshot, defaultYear?: number): Reservation[] {
  const out: Reservation[] = [];
  for (const anchor of snapshot.anchors) {
    const url = new URL(anchor.href);
    const parts = url.pathname.split('/').filter(Boolean);
    const confCandidate = parts[parts.length - 1]?.toUpperCase() ?? '';
    if (!CONF_CODE_RE.test(confCandidate)) continue;
    const dateRange = extractDateRangeFromText(anchor.cardText, defaultYear);
    if (!dateRange) continue;
    const guestName = parseGuestName(anchor.text, anchor.cardText);
    if (!guestName) continue;
    out.push({
      conf_code: confCandidate,
      guest_name: guestName,
      check_in: dateRange.checkIn,
      check_out: dateRange.checkOut,
      status_text: parseStatusText(anchor.cardText),
      listing_id: null,
      listing_name: null,
      guest_count: null,
      total_payout: null,
      guest_paid: null,
      reservation_url: anchor.href,
      conversation_airbnb_id: null,
    });
  }
  return out;
}

function parseStatusText(text: string): string {
  const match = text.match(/\b(confirmed|accepted|cancelled|canceled|pending|awaiting payment|completed|inquiry|request(?:ed)?(?: to book)?)\b/i);
  return match?.[1] ?? 'Unknown';
}

function hasEmptyState(snapshot: PageSnapshot): boolean {
  return /no (upcoming |past |current )?reservations|no reservations found|you don'?t have any reservations/i.test(
    snapshot.text,
  );
}

async function clickNextIfAvailable(page: Page): Promise<boolean> {
  const next = page
    .locator('a[aria-label*="Next" i], button[aria-label*="Next" i], a:has-text("Next"), button:has-text("Next")')
    .last();
  if ((await next.count()) === 0) return false;
  if ((await next.isDisabled().catch(() => false)) === true) return false;
  const clicked = await next.click({ timeout: 5000 }).then(
    () => true,
    () => false,
  );
  if (!clicked) return false;
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  return true;
}

export async function scrapeReservationList(
  ctx: BrowserContext,
  opts: ScrapeReservationsOptions,
): Promise<ScrapeReservationsResult> {
  const page = await ctx.newPage();

  try {
    let bootstrapNavigationError: string | null = null;
    let initialSnapshot: PageSnapshot | null = null;
    const shouldBootstrapDom = opts.cursor === null || !opts.apiKey;
    const bootstrap = shouldBootstrapDom
      ? await collectJsonCandidates(page, async () => {
        await page.goto(RESERVATIONS_URL, { waitUntil: 'commit', timeout: 60_000 }).catch((err) => {
          bootstrapNavigationError = errorMessage(err);
          console.warn('reservation_list_bootstrap_goto_failed', {
            message: bootstrapNavigationError,
          });
        });
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(2000);
      })
      : [];
    if (shouldBootstrapDom) {
      initialSnapshot = await snapshotPage(page);
    }
    if (bootstrap.length === 0 && bootstrapNavigationError) {
      console.warn('reservation_list_bootstrap_missing_static_api_fallback', {
        navigationError: bootstrapNavigationError,
      });
    }
    let apiResult: Awaited<ReturnType<typeof readReservationsViaApi>>;
    try {
      apiResult = await readReservationsViaApi(ctx, bootstrap, opts);
    } catch (err) {
      if (err instanceof ReservationListCursorError) throw err;
      if (isReservationListApiAuthError(err)) throw err;
      if (opts.cursor !== null) throw err;
      apiResult = null;
    }
    if (
      apiResult &&
      (apiResult.reservations.length > 0 ||
        apiResult.totalCount === 0 ||
        opts.cursor !== null ||
        (initialSnapshot !== null && hasEmptyState(initialSnapshot)))
    ) {
      const mergedReservations = mergeReservations(apiResult.reservations);
      const reservations = filterByWindow(mergedReservations, opts.window_start, opts.window_end);

      return {
        schema_version: 3,
        mode: opts.mode,
        window_start: opts.window_start,
        window_end: opts.window_end,
        page_cursor: apiResult.pageCursor,
        next_page_cursor: apiResult.nextPageCursor,
        page_index: apiResult.pageIndex,
        is_complete: apiResult.isComplete,
        scraped_at: new Date().toISOString(),
        reservations,
        diagnostics: {
          ...apiResult.diagnostics,
          filtered_reservations: reservations.length,
          merged_reservations: mergedReservations.length,
        },
      };
    }

    if (opts.cursor !== null) {
      throw new Error('reservation_list_cursor_requires_api_reader');
    }

    const fallbackResult = await scrapeReservationListViaDom(page, opts);
    return fallbackResult;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function scrapeReservationListViaDom(
  page: Page,
  opts: ScrapeReservationsOptions,
): Promise<ScrapeReservationsResult> {
  const budget = pageBudget(opts.mode);
  const allReservations: Reservation[] = [];
  let sawExplicitEmptyState = false;
  let lastSnapshot: PageSnapshot | null = null;
  let candidates: JsonCandidate[] = [];

  candidates = await collectJsonCandidates(page, async () => {
    for (let pageIdx = 0; pageIdx < budget; pageIdx += 1) {
      if (pageIdx === 0) {
        await page.goto(RESERVATIONS_URL, { waitUntil: 'commit', timeout: 60_000 }).catch((err) => {
          console.warn('reservation_list_dom_fallback_goto_failed', {
            message: errorMessage(err),
          });
        });
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(2000);

      const snapshot = await snapshotPage(page);
      lastSnapshot = snapshot;
      sawExplicitEmptyState = sawExplicitEmptyState || hasEmptyState(snapshot);
      allReservations.push(
        ...reservationsFromDom(snapshot, Number(opts.window_start.slice(0, 4))),
      );

      const hasNext = await clickNextIfAvailable(page);
      if (!hasNext) break;
      if (pageIdx === budget - 1) {
        throw new Error('reservation_list_page_budget_exceeded');
      }
    }
  });

  for (const candidate of candidates) {
    allReservations.push(...collectJsonReservations(candidate.value, candidate.sourceUrl));
  }

  const mergedReservations = mergeReservations(allReservations);
  if (mergedReservations.length === 0 && !sawExplicitEmptyState) {
    const snapshotForDiagnostics = lastSnapshot as PageSnapshot | null;
    // Non-PII diagnostics only: helps distinguish auth/challenge/API-shape
    // failures without logging guest names, payouts, or confirmation codes.
    // eslint-disable-next-line no-console
    console.warn('reservation_list_no_data_detected', {
      page_url: snapshotForDiagnostics?.url,
      page_title: snapshotForDiagnostics?.title,
      page_text_length: snapshotForDiagnostics?.text.length ?? null,
      anchor_count: snapshotForDiagnostics?.anchors.length ?? null,
      json_candidates: candidates.map(jsonCandidateDiagnostic).slice(0, 20),
    });
    throw new Error('reservation_list_no_data_detected');
  }
  const reservations = filterByWindow(mergedReservations, opts.window_start, opts.window_end);

  return {
    schema_version: 3,
    mode: opts.mode,
    window_start: opts.window_start,
    window_end: opts.window_end,
    page_cursor: opts.cursor,
    next_page_cursor: null,
    page_index: 0,
    is_complete: true,
    scraped_at: new Date().toISOString(),
    reservations,
    diagnostics: {
      source: 'dom',
      filtered_reservations: reservations.length,
      merged_reservations: mergedReservations.length,
      saw_explicit_empty_state: sawExplicitEmptyState,
    },
  };
}

export const __reservationScraperTestHooks = {
  collectJsonReservations,
  extractReservationFromObject,
  filterByWindow,
  hasEmptyState,
  isReservationListApiAuthError,
  mergeReservations,
  normalizeDate,
  numberish,
  maxApiRowCheckIn,
  reservationApiRows,
  reservationsApiUrl,
  reservationsFromDom,
  encodeReservationListCursor,
  decodeReservationListCursor,
  subtractDaysFromDateOnly,
};
