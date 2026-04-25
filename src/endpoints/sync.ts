/**
 * POST /sync — HMAC-authed.
 * Spec §2.4 step 5 + §2.7.
 *
 * Request body:
 *   { host_id: string, mode: 'initial' | 'incremental' | 'full', since?: ISO8601 }
 *
 * Response (sync, AFTER all batches posted):
 *   { messages_found: number, bookings_found: number, errors: string[] }
 *
 * Callback pagination (spec §2.7 "Message delivery during sync"):
 *   POST ${CALLBACK_URL} with body:
 *     {
 *       action: "sync_messages_batch",
 *       host_id,
 *       payload: { messages: [...max 50...], page: number (1-indexed), has_more: boolean }
 *     }
 *   Keep POSTing until has_more === false, then return the summary synchronously.
 *
 * NOTE: This PR ships the endpoint + callback plumbing but uses a STUB scraper.
 * Real Airbnb inbox scraping (DOM selectors, infinite scroll, pagination) is a follow-up:
 * the inbox DOM is stable enough in the sibling GAS project to crib from when wiring the
 * real scraper in PR 3+. Keeping PR 2 focused on: HMAC, endpoint contract, callback shape,
 * and the 50-msg batching behaviour spec §2.7 mandates.
 */

import type { Request, Response } from 'express';
import type { MachineEnv } from '../lib/env';
import { postCallback } from '../lib/callback';
import { getBrowserContext, markAirbnbRequest } from '../playwright/browser';
import { scrapeInbox, type ScrapedMessage } from '../playwright/scrape-inbox';

interface SyncBody {
  host_id: string;
  mode: 'initial' | 'incremental' | 'full';
  since?: string;
  // Display name shown on the host's Airbnb profile — used to classify each
  // scraped message as 'host' vs 'guest' from the aria-label "<Name> sent ..."
  // pattern. Optional for back-compat; without it, every non-system message
  // defaults to 'guest' and the saga must reclassify host messages downstream.
  host_display_name?: string;
}

const MAX_BATCH_SIZE = 50;

function isValidSyncBody(body: unknown): body is SyncBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<SyncBody>;
  if (typeof b.host_id !== 'string' || b.host_id.length === 0) return false;
  if (b.mode !== 'initial' && b.mode !== 'incremental' && b.mode !== 'full') return false;
  if (b.since !== undefined && typeof b.since !== 'string') return false;
  if (b.host_display_name !== undefined && typeof b.host_display_name !== 'string') return false;
  return true;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function syncHandler(env: MachineEnv) {
  return async (req: Request, res: Response) => {
    if (!isValidSyncBody(req.body)) {
      return res.status(400).json({ error: 'malformed_body' });
    }

    // Machine HOST_ID is the source of truth (HMAC already bound it). Guard against mismatch.
    if (req.body.host_id !== env.HOST_ID) {
      return res.status(403).json({ error: 'host_id_mismatch' });
    }

    // Ensure the browser is up — spec §2.5 step 1 relies on this for cookie validity too.
    let ctx;
    try {
      ctx = await getBrowserContext({ profileDir: env.PROFILE_DIR });
    } catch (err) {
      return res.status(500).json({
        messages_found: 0,
        bookings_found: 0,
        errors: ['browser_failed: ' + (err instanceof Error ? err.message : String(err))],
      });
    }

    markAirbnbRequest();
    const { messages, bookingsFound, errors } = await scrapeInbox(ctx, {
      mode: req.body.mode,
      since: req.body.since,
      hostDisplayName: req.body.host_display_name,
    });

    const batches = chunk(messages, MAX_BATCH_SIZE);
    // Always emit at least one batch so the callback handler sees has_more=false closure even
    // when there are zero messages (avoids callers inferring "sync never completed").
    const effective = batches.length > 0 ? batches : [[] as ScrapedMessage[]];

    const callbackErrors: string[] = [];
    for (let i = 0; i < effective.length; i++) {
      const isLast = i === effective.length - 1;
      const body = {
        action: 'sync_messages_batch' as const,
        host_id: env.HOST_ID,
        payload: {
          messages: effective[i],
          page: i + 1,
          has_more: !isLast,
        },
        timestamp: new Date().toISOString(), // for current staysync-app callback route skew check
      };
      try {
        const resCb = await postCallback({ env, body });
        if (!resCb.ok) {
          callbackErrors.push(`batch_${i + 1}_status_${resCb.status}`);
        }
      } catch (err) {
        callbackErrors.push(
          `batch_${i + 1}_error: ` + (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const diag = (globalThis as unknown as { __lastInboxDiag?: unknown }).__lastInboxDiag;
    return res.status(200).json({
      messages_found: messages.length,
      bookings_found: bookingsFound,
      errors: [...errors, ...callbackErrors],
      diag,
    });
  };
}
