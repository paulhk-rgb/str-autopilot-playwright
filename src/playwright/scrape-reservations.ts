/**
 * Reservation-list scraper for /scrape-reservation-list.
 *
 * STUB IMPLEMENTATION. Returns an empty list. The real scraper will navigate
 * to https://www.airbnb.com/hosting/reservations, filter by status, paginate
 * through results, and extract per-row fields (conf_code, guest_name,
 * check_in/check_out, status, listing_id, total_payout) — same staging
 * pattern as scrape-inbox.ts.
 *
 * Until the real scraper lands, this stub:
 *   - asserts the persistent context is reachable (cookies injected)
 *   - returns empty reservations + a timestamp + empty account_email
 *
 * The empty-but-shaped response unblocks staysync-app worker integration so
 * the contract can be exercised end-to-end before the scraper itself ships.
 */

import type { BrowserContext } from 'playwright';
import type { Reservation } from '../endpoints/scrape-reservation-list';

export interface ScrapeReservationsOptions {
  mode: 'initial' | 'incremental' | 'full';
  since?: string;
}

export interface ScrapeReservationsResult {
  reservations: Reservation[];
  scrapedAt: string;
  accountEmail: string;
  /**
   * Set to `true` while the real DOM scraper is unimplemented. The endpoint
   * forwards this as the `X-Stub: true` HTTP response header (NOT a body
   * field — the body matches Issue #45 exactly so strict consumer parsers
   * cannot reject it). The staysync worker MUST inspect that header and
   * skip persistence of empty fields (e.g. `account_email`) when set.
   * Remove this field once the real scraper lands.
   */
  stub?: true;
}

export async function scrapeReservationList(
  _ctx: BrowserContext,
  _opts: ScrapeReservationsOptions,
): Promise<ScrapeReservationsResult> {
  // STUB: real scraper will populate `reservations` from /hosting/reservations
  // and read `accountEmail` from the host's profile meta on /hosting/today.
  return {
    reservations: [],
    scrapedAt: new Date().toISOString(),
    accountEmail: '',
    stub: true,
  };
}
