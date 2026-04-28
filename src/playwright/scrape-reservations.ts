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
}

export async function scrapeReservationList(
  _ctx: BrowserContext,
  _opts: ScrapeReservationsOptions,
): Promise<ScrapeReservationsResult> {
  return {
    reservations: [],
    scrapedAt: new Date().toISOString(),
    accountEmail: '',
  };
}
