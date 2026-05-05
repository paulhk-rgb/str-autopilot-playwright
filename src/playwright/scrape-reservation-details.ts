/**
 * Reservation-detail financial scraper for /scrape-reservation-details.
 *
 * The list API gives stable reservation identity. This reader enriches those
 * rows from Airbnb's own reservation details payment panel by confirmation
 * code, using the organic persisted GraphQL query emitted by the SPA.
 */

import type { BrowserContext, Page, Response as PlaywrightResponse } from 'playwright';

export interface ReservationDetailLineItem {
  label: string;
  formatted_value: string;
  amount: number | null;
  children?: ReservationDetailLineItem[];
}

export interface ReservationDetailFinancialGroup {
  group_name: string;
  line_items: ReservationDetailLineItem[];
  total_line_item: ReservationDetailLineItem | null;
}

export interface ReservationDetailFinancials {
  guest_total: number | null;
  accommodation_amount: number | null;
  guest_service_fee: number | null;
  occupancy_taxes: number | null;
  host_payout: number | null;
  host_room_amount: number | null;
  cleaning_fee: number | null;
  host_service_fee_amount: number | null;
  adjustment_amount: number | null;
}

export interface ScrapedReservationDetail {
  conf_code: string;
  currency: string;
  nights_from_detail: number | null;
  guest_paid_group: ReservationDetailFinancialGroup;
  host_earnings_group: ReservationDetailFinancialGroup;
  financials: ReservationDetailFinancials;
  unknown_host_line_labels: string[];
}

export interface MissingReservationDetail {
  conf_code: string;
  reason: string;
}

export interface ScrapeReservationDetailsOptions {
  confirmation_codes: string[];
  apiKey?: string | null;
}

export interface ScrapeReservationDetailsResult {
  schema_version: 1;
  scraped_at: string;
  details: ScrapedReservationDetail[];
  missing_details: MissingReservationDetail[];
}

interface JsonCandidate {
  value: unknown;
  sourceUrl: string;
  status: number;
  requestHeaders: Record<string, string>;
}

interface DetailBootstrap {
  templateUrl: string;
  headers: Record<string, string>;
  firstCandidate: JsonCandidate | null;
  currencyHint: string | null;
}

const RESERVATIONS_URL = 'https://www.airbnb.com/hosting/reservations/all';
const DETAIL_QUERY_NAME = 'StayHostingDetailsQuery';
const DETAIL_REQUEST_SOURCE = 'RESERVATION_LIST';
const DETAIL_MAX_ATTEMPTS = 3;
const DETAIL_RETRY_BASE_MS = 700;
const DETAIL_REPLAY_DELAY_MS = 350;
const CONF_CODE_RE = /^(?=.*[a-z])(?=.*\d)[a-z0-9-]{6,}$/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeConfirmationCode(value: string): string {
  return value.trim().toUpperCase();
}

function textish(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumberString(value: string): string | null {
  let cleaned = value.replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    cleaned = lastComma > lastDot
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (lastComma !== -1) {
    cleaned = /,\d{1,2}$/.test(cleaned)
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');
  }
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
}

function moneyish(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return roundMoney(value);
  const text = textish(value);
  if (!text) return null;
  const cleaned = normalizeNumberString(text);
  if (!cleaned) return null;
  const sign = /-\s*[$€£¥]|^\s*-/.test(text) || /^\s*\(/.test(text) ? -1 : 1;
  const n = Number(cleaned);
  return Number.isFinite(n) ? roundMoney(Math.abs(n) * sign) : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumKnown(values: Array<number | null | undefined>): number | null {
  let sawValue = false;
  let total = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    sawValue = true;
    total += value;
  }
  return sawValue ? roundMoney(total) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDetailQueryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.includes(`/${DETAIL_QUERY_NAME}/`) ||
      parsed.searchParams.get('operationName') === DETAIL_QUERY_NAME;
  } catch {
    return false;
  }
}

async function collectDetailCandidates(page: Page, action: () => Promise<void>): Promise<JsonCandidate[]> {
  const candidates: JsonCandidate[] = [];
  const listener = async (response: PlaywrightResponse) => {
    const url = response.url();
    if (!isDetailQueryUrl(url)) return;
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
      // Ignore non-readable response bodies.
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

function detailHeadersFromBootstrap(
  candidate: JsonCandidate,
  apiKey: string | null | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(candidate.requestHeaders)) {
    const key = rawKey.toLowerCase();
    if (
      key === 'accept' ||
      key === 'content-type' ||
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
  if (!headers['x-airbnb-api-key']) throw new Error('reservation_detail_api_key_missing');
  headers.accept = headers.accept ?? 'application/json';
  return headers;
}

function detailUrlForConfirmation(templateUrl: string, confCode: string): string {
  const parsed = new URL(templateUrl);
  const variablesRaw = parsed.searchParams.get('variables');
  const variables = variablesRaw ? JSON.parse(variablesRaw) as Record<string, unknown> : {};
  const nextVariables: Record<string, unknown> = {
    confirmationCode: confCode,
    requestSource: typeof variables.requestSource === 'string'
      ? variables.requestSource
      : DETAIL_REQUEST_SOURCE,
  };
  if (typeof variables.viewerTimeZoneOffset === 'number' && Number.isFinite(variables.viewerTimeZoneOffset)) {
    nextVariables.viewerTimeZoneOffset = variables.viewerTimeZoneOffset;
  }
  parsed.searchParams.set('variables', JSON.stringify(nextVariables));
  return parsed.toString();
}

function confirmationCodeFromDetailUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const variablesRaw = parsed.searchParams.get('variables');
    if (!variablesRaw) return null;
    const variables = JSON.parse(variablesRaw) as Record<string, unknown>;
    const confirmationCode = textish(variables.confirmationCode);
    return confirmationCode ? normalizeConfirmationCode(confirmationCode) : null;
  } catch {
    return null;
  }
}

function selectBootstrapDetailCandidate(
  candidates: JsonCandidate[],
  confirmationCode: string,
): { templateCandidate: JsonCandidate | null; reusableFirstCandidate: JsonCandidate | null } {
  const normalizedCode = normalizeConfirmationCode(confirmationCode);
  const exactCandidate = candidates.find(
    (candidate) =>
      isDetailQueryUrl(candidate.sourceUrl) &&
      confirmationCodeFromDetailUrl(candidate.sourceUrl) === normalizedCode,
  ) ?? null;
  return {
    templateCandidate: exactCandidate ?? candidates.find((candidate) => isDetailQueryUrl(candidate.sourceUrl)) ?? null,
    reusableFirstCandidate: exactCandidate,
  };
}

async function bootstrapDetailQuery(
  ctx: BrowserContext,
  confirmationCode: string,
  apiKey: string | null | undefined,
): Promise<DetailBootstrap> {
  const page = await ctx.newPage();
  try {
    const bootstrapUrl = `${RESERVATIONS_URL}?locale=en&confirmationCode=${encodeURIComponent(confirmationCode)}`;
    let bootstrapNavigationError: string | null = null;
    const candidates = await collectDetailCandidates(page, async () => {
      await page.goto(bootstrapUrl, { waitUntil: 'commit', timeout: 60_000 }).catch((err) => {
        bootstrapNavigationError = errorMessage(err);
        console.warn('reservation_detail_bootstrap_goto_failed', {
          confirmationCode,
          message: bootstrapNavigationError,
        });
      });
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(3000);
    });
    const { templateCandidate, reusableFirstCandidate } = selectBootstrapDetailCandidate(
      candidates,
      confirmationCode,
    );
    if (!templateCandidate) {
      console.warn('reservation_detail_query_bootstrap_missing', {
        confirmationCode,
        navigationError: bootstrapNavigationError,
      });
      throw new Error('reservation_detail_query_bootstrap_missing');
    }
    const parsed = new URL(templateCandidate.sourceUrl);
    return {
      templateUrl: templateCandidate.sourceUrl,
      headers: detailHeadersFromBootstrap(templateCandidate, apiKey),
      firstCandidate: reusableFirstCandidate,
      currencyHint: textish(parsed.searchParams.get('currency'))?.toUpperCase() ?? null,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function graphqlErrors(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const errors = (value as Record<string, unknown>).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors
    .map((error) => {
      if (error && typeof error === 'object') {
        return textish((error as Record<string, unknown>).message) ?? 'graphql_error';
      }
      return 'graphql_error';
    })
    .join('; ');
}

async function fetchDetailJson(input: {
  ctx: BrowserContext;
  bootstrap: DetailBootstrap;
  confCode: string;
}): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const url = detailUrlForConfirmation(input.bootstrap.templateUrl, input.confCode);
  let lastReason = 'reservation_detail_api_failed';
  for (let attempt = 1; attempt <= DETAIL_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await input.ctx.request.get(url, {
        headers: {
          ...input.bootstrap.headers,
          referer: `${RESERVATIONS_URL}?locale=en&confirmationCode=${encodeURIComponent(input.confCode)}`,
        },
        timeout: 30_000,
      });
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      if (attempt === DETAIL_MAX_ATTEMPTS) break;
      await sleep(DETAIL_RETRY_BASE_MS * attempt);
      continue;
    }

    const status = response.status();
    const text = await response.text();
    if (status >= 200 && status < 300) {
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error('reservation_detail_api_malformed_json');
      }
      const errors = graphqlErrors(value);
      if (errors) throw new Error(`reservation_detail_graphql_errors:${errors}`);
      return { ok: true, value };
    }
    lastReason = `reservation_detail_api_failed:${status}`;
    if (status === 404) return { ok: false, reason: lastReason };
    if (isFatalDetailStatus(status)) {
      throw new Error(lastReason);
    }
    if (!isRetriableDetailStatus(status)) break;
    if (attempt < DETAIL_MAX_ATTEMPTS) await sleep(DETAIL_RETRY_BASE_MS * attempt);
  }
  throw new Error(lastReason);
}

function isFatalDetailStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

function isRetriableDetailStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function findPaymentSection(value: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  function walk(node: unknown): Record<string, unknown> | null {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    if (
      obj.__typename === 'HostingDetailsPaymentInfoSection' ||
      (obj.guestPaidGroup && obj.hostEarningsGroup)
    ) {
      return obj;
    }
    for (const child of Object.values(obj)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }
  return walk(value);
}

function parseLineItem(value: unknown): ReservationDetailLineItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const label = textish(obj.label);
  const formatted = textish(obj.formattedValue) ?? textish(obj.formatted_value);
  if (!label || !formatted) return null;
  const collapsible = obj.collapsibleLineItemGroup;
  let children: ReservationDetailLineItem[] | undefined;
  if (collapsible && typeof collapsible === 'object' && !Array.isArray(collapsible)) {
    const rawChildren = (collapsible as Record<string, unknown>).collapsedLineItems;
    if (Array.isArray(rawChildren)) {
      const parsedChildren = rawChildren
        .map(parseLineItem)
        .filter((line): line is ReservationDetailLineItem => line !== null);
      if (parsedChildren.length > 0) children = parsedChildren;
    }
  }
  return {
    label,
    formatted_value: formatted,
    amount: moneyish(formatted),
    ...(children ? { children } : {}),
  };
}

function parseFinancialGroup(value: unknown): ReservationDetailFinancialGroup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const groupName = textish(obj.groupName) ?? textish(obj.group_name);
  const lineItems = Array.isArray(obj.lineItems)
    ? obj.lineItems
      .map(parseLineItem)
      .filter((line): line is ReservationDetailLineItem => line !== null)
    : [];
  const totalLineItem = parseLineItem(obj.totalLineItem) ?? null;
  if (!groupName || (!totalLineItem && lineItems.length === 0)) return null;
  return {
    group_name: groupName,
    line_items: lineItems,
    total_line_item: totalLineItem,
  };
}

function labelIncludes(line: ReservationDetailLineItem, pattern: RegExp): boolean {
  return pattern.test(line.label);
}

function firstAmount(
  lines: ReservationDetailLineItem[],
  pattern: RegExp,
  transform: (value: number) => number = (value) => value,
): number | null {
  const line = lines.find((candidate) => labelIncludes(candidate, pattern) && candidate.amount !== null);
  return line?.amount == null ? null : roundMoney(transform(line.amount));
}

function isKnownHostLine(line: ReservationDetailLineItem): boolean {
  return (
    /\b(cleaning fee|host service fee)\b/i.test(line.label) ||
    /\b(room fee|total stay price|accommodation)\b/i.test(line.label) ||
    /^\s*\$?[\d,.]+\s*x\s*\d+\s+nights?\b/i.test(line.label)
  );
}

function isKnownHostAdjustmentLine(line: ReservationDetailLineItem): boolean {
  return (
    /\bnightly rate adjustment\b/i.test(line.label) ||
    /\bpet fee\b/i.test(line.label)
  );
}

function hostRoomAmount(lines: ReservationDetailLineItem[]): number | null {
  const line = lines.find(
    (candidate) =>
      /\b(room fee|total stay price|accommodation)\b/i.test(candidate.label) &&
      !/\b(adjustment|discount|refund|resolution|promotion)\b/i.test(candidate.label) &&
      candidate.amount !== null,
  );
  return line?.amount ?? null;
}

function guestAccommodationAmount(lines: ReservationDetailLineItem[]): number | null {
  const line = lines.find(
    (candidate) =>
      !/\b(cleaning fee|guest service fee|occupancy tax|taxes?|vat)\b/i.test(candidate.label) &&
      candidate.amount !== null,
  );
  return line?.amount ?? null;
}

function parseCurrency(section: Record<string, unknown>, currencyHint: string | null): string | null {
  const labels = [
    parseLineItem(section.totalLineItem)?.label,
    parseFinancialGroup(section.guestPaidGroup)?.total_line_item?.label,
    parseFinancialGroup(section.hostEarningsGroup)?.total_line_item?.label,
  ];
  for (const label of labels) {
    const match = label?.match(/\(([A-Z]{3})\)/);
    if (match) return match[1];
  }
  return currencyHint && /^[A-Z]{3}$/.test(currencyHint) ? currencyHint : null;
}

function parseNights(section: Record<string, unknown>, groups: ReservationDetailFinancialGroup[]): number | null {
  const labels = [
    parseLineItem(section.summaryLineItem)?.label,
    ...groups.flatMap((group) => [
      group.total_line_item?.label,
      ...group.line_items.map((line) => line.label),
    ]),
  ];
  for (const label of labels) {
    const match = label?.match(/\b(\d+)\s+nights?\b/i);
    if (match) return Number(match[1]);
  }
  return null;
}

export function extractReservationDetailFromJson(
  confCodeRaw: string,
  value: unknown,
  currencyHint: string | null = null,
): ScrapedReservationDetail | null {
  const confCode = normalizeConfirmationCode(confCodeRaw);
  if (!CONF_CODE_RE.test(confCode)) return null;
  const section = findPaymentSection(value);
  if (!section) return null;
  const guestPaidGroup = parseFinancialGroup(section.guestPaidGroup);
  const hostEarningsGroup = parseFinancialGroup(section.hostEarningsGroup);
  const currency = parseCurrency(section, currencyHint);
  if (!guestPaidGroup || !hostEarningsGroup || !currency) return null;

  const hostLines = hostEarningsGroup.line_items;
  const guestLines = guestPaidGroup.line_items;
  const adjustmentLines = hostLines.filter(
    (line) => line.amount !== null && (!isKnownHostLine(line) || isKnownHostAdjustmentLine(line)),
  );
  const unknownHostLineLabels = adjustmentLines
    .filter((line) => !isKnownHostAdjustmentLine(line) && !isKnownHostLine(line))
    .map((line) => line.label);
  const nightsFromDetail = parseNights(section, [guestPaidGroup, hostEarningsGroup]);
  const hostServiceFeeRaw = firstAmount(hostLines, /\bhost service fee\b/i);

  return {
    conf_code: confCode,
    currency,
    nights_from_detail: nightsFromDetail,
    guest_paid_group: guestPaidGroup,
    host_earnings_group: hostEarningsGroup,
    financials: {
      guest_total: guestPaidGroup.total_line_item?.amount ?? null,
      accommodation_amount: guestAccommodationAmount(guestLines),
      guest_service_fee: firstAmount(guestLines, /\bguest service fee\b/i),
      occupancy_taxes: firstAmount(guestLines, /\b(occupancy tax|occupancy taxes|taxes)\b/i),
      host_payout: hostEarningsGroup.total_line_item?.amount ?? null,
      host_room_amount: hostRoomAmount(hostLines),
      cleaning_fee: firstAmount(hostLines, /\bcleaning fee\b/i) ?? firstAmount(guestLines, /\bcleaning fee\b/i),
      host_service_fee_amount: hostServiceFeeRaw == null ? null : roundMoney(Math.abs(hostServiceFeeRaw)),
      adjustment_amount: sumKnown(adjustmentLines.map((line) => line.amount)),
    },
    unknown_host_line_labels: unknownHostLineLabels,
  };
}

export async function scrapeReservationDetails(
  ctx: BrowserContext,
  opts: ScrapeReservationDetailsOptions,
): Promise<ScrapeReservationDetailsResult> {
  const codes = Array.from(new Set(opts.confirmation_codes.map(normalizeConfirmationCode)));
  if (codes.length === 0) {
    throw new Error('reservation_detail_confirmation_codes_required');
  }

  const scrapedAt = new Date().toISOString();
  const bootstrap = await bootstrapDetailQuery(ctx, codes[0], opts.apiKey);
  const details: ScrapedReservationDetail[] = [];
  const missingDetails: MissingReservationDetail[] = [];

  for (let index = 0; index < codes.length; index += 1) {
    const confCode = codes[index];
    if (index > 0) await sleep(DETAIL_REPLAY_DELAY_MS);

    const valueResult =
      confCode === codes[0] &&
      bootstrap.firstCandidate !== null &&
      bootstrap.firstCandidate.status >= 200 &&
      bootstrap.firstCandidate.status < 300
        ? { ok: true as const, value: bootstrap.firstCandidate.value }
        : await fetchDetailJson({ ctx, bootstrap, confCode });

    if (!valueResult.ok) {
      missingDetails.push({ conf_code: confCode, reason: valueResult.reason });
      continue;
    }
    const errors = graphqlErrors(valueResult.value);
    if (errors) throw new Error(`reservation_detail_graphql_errors:${errors}`);
    const detail = extractReservationDetailFromJson(confCode, valueResult.value, bootstrap.currencyHint);
    if (!detail) {
      missingDetails.push({ conf_code: confCode, reason: 'reservation_detail_payment_section_missing' });
      continue;
    }
    details.push(detail);
  }

  return {
    schema_version: 1,
    scraped_at: scrapedAt,
    details,
    missing_details: missingDetails,
  };
}

export const __reservationDetailScraperTestHooks = {
  confirmationCodeFromDetailUrl,
  detailUrlForConfirmation,
  extractReservationDetailFromJson,
  isFatalDetailStatus,
  isRetriableDetailStatus,
  isKnownHostAdjustmentLine,
  isKnownHostLine,
  moneyish,
  parseLineItem,
  selectBootstrapDetailCandidate,
};
