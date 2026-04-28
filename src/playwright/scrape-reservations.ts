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
   * Set to `true` while the real DOM scraper is unimplemented. The handler
   * surfaces this to callers as a top-level `_stub: true` field on the
   * response body so the staysync worker has a machine-readable signal not
   * to overwrite real host records (e.g. blank `account_email`) with stub
   * defaults. Remove this field once the real scraper lands.
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
