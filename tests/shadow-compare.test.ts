import { describe, expect, it } from 'vitest';
import { computeShadowComparison } from '../src/endpoints/sync';
import type { ScrapedMessage } from '../src/playwright/api-reader';

/** Build a canonical-form message. CANONICAL_MESSAGE_ID requires `\d{6,}` so
 *  pad short IDs to 11 digits (real Airbnb message ids are 11 digits per
 *  probe 2026-04-26). */
function msg(id: string, threadId: string, ts: string): ScrapedMessage {
  const padded = id.padStart(11, '0');
  return {
    airbnb_message_id: `airbnb-${padded}`,
    content: `[REDACTED:body]`,
    sender: 'guest',
    timestamp: ts,
    conversation_airbnb_id: threadId,
  };
}

describe('computeShadowComparison', () => {
  it('passes identical batches (UI = API): no mismatches, full intersection', () => {
    const a = [msg('1', 't1', '2026-04-26T10:00:00Z'), msg('2', 't1', '2026-04-26T10:01:00Z')];
    const result = computeShadowComparison(a, a, 'cyc1');
    expect(result.diagnostic.uiToApiIdMismatches).toBe(0);
    expect(result.diagnostic.onlyInUi).toEqual([]);
    expect(result.diagnostic.onlyInApi).toEqual([]);
    expect(result.diagnostic.uiToApiIdMatches).toBe(2);
    expect(result.advance.t1).toBe(Date.parse('2026-04-26T10:01:00Z'));
  });

  it('UI ⊆ API with extra API entries (virtualization): zero mismatches, onlyInApi populated', () => {
    const ui = [msg('1', 't1', '2026-04-26T10:00:00Z')];
    const api = [
      msg('1', 't1', '2026-04-26T10:00:00Z'),
      msg('2', 't1', '2026-04-26T10:01:00Z'),
      msg('3', 't1', '2026-04-26T10:02:00Z'),
    ];
    const result = computeShadowComparison(ui, api, 'cyc');
    expect(result.diagnostic.uiToApiIdMismatches).toBe(0);
    expect(result.diagnostic.onlyInUi).toEqual([]);
    expect(result.diagnostic.onlyInApi.sort()).toEqual(['airbnb-00000000002', 'airbnb-00000000003']);
    expect(result.diagnostic.uiToApiIdMatches).toBe(1);
  });

  it('UI ⊄ API: onlyInUi populated, mismatches counted (promotion blocking)', () => {
    const ui = [msg('1', 't1', '2026-04-26T10:00:00Z'), msg('99', 't1', '2026-04-26T10:05:00Z')];
    const api = [msg('1', 't1', '2026-04-26T10:00:00Z')];
    const result = computeShadowComparison(ui, api, 'cyc');
    expect(result.diagnostic.uiToApiIdMismatches).toBe(1);
    expect(result.diagnostic.onlyInUi).toEqual(['airbnb-00000000099']);
  });

  it('watermark advance is per-thread max of intersection ONLY', () => {
    const ui = [msg('1', 't1', '2026-04-26T10:00:00Z'), msg('2', 't2', '2026-04-26T11:00:00Z')];
    const api = [
      msg('1', 't1', '2026-04-26T10:00:00Z'),
      msg('2', 't2', '2026-04-26T11:00:00Z'),
      // API-only message — should NOT contribute to advance.
      msg('99', 't1', '2026-04-26T10:30:00Z'),
    ];
    const result = computeShadowComparison(ui, api, 'cyc');
    expect(result.advance.t1).toBe(Date.parse('2026-04-26T10:00:00Z'));
    expect(result.advance.t2).toBe(Date.parse('2026-04-26T11:00:00Z'));
  });

  it('vacuous-match defense: empty UI batch → empty advance (Sonnet R2)', () => {
    const api = [msg('1', 't1', '2026-04-26T10:00:00Z')];
    const result = computeShadowComparison([], api, 'cyc');
    expect(result.advance).toEqual({});
    expect(result.diagnostic.onlyInApi).toEqual(['airbnb-00000000001']);
    expect(result.diagnostic.onlyInUi).toEqual([]);
  });

  it('empty API batch with UI messages → all UI messages are mismatches', () => {
    const ui = [msg('1', 't1', '2026-04-26T10:00:00Z'), msg('2', 't1', '2026-04-26T10:01:00Z')];
    const result = computeShadowComparison(ui, [], 'cyc');
    expect(result.diagnostic.uiToApiIdMismatches).toBe(2);
    expect(result.diagnostic.onlyInUi.sort()).toEqual(['airbnb-00000000001', 'airbnb-00000000002']);
    expect(result.advance).toEqual({});
  });

  it('cycleId echoed verbatim into diagnostic', () => {
    const result = computeShadowComparison([], [], 'cyc-2026-04-26-deadbeef');
    expect(result.diagnostic.cycleId).toBe('cyc-2026-04-26-deadbeef');
  });

  it('UI fallback (non-canonical hash) IDs are excluded from equivalence gate', () => {
    // UI scraper falls back to a 32-char hex hash when DOM data-item-id is absent.
    // Per Codex v0.4-prereq audit Blocker fix: those IDs must NOT count as
    // promotion-blocking mismatches.
    const ui: ScrapedMessage[] = [
      msg('1', 't1', '2026-04-26T10:00:00Z'), // canonical
      {
        // non-canonical fallback ID — 32 hex chars, no airbnb- prefix
        airbnb_message_id: 'a'.repeat(32),
        content: '[REDACTED:body]',
        sender: 'guest',
        timestamp: '2026-04-26T10:01:00Z',
        conversation_airbnb_id: 't1',
      },
    ];
    const api = [msg('1', 't1', '2026-04-26T10:00:00Z')];
    const result = computeShadowComparison(ui, api, 'cyc');
    // The fallback ID is NOT counted as onlyInUi (would falsely block promotion).
    expect(result.diagnostic.onlyInUi).toEqual([]);
    expect(result.diagnostic.uiToApiIdMismatches).toBe(0);
    expect(result.diagnostic.uiNonCanonicalCount).toBe(1);
    expect(result.diagnostic.uiCanonicalCount).toBe(1);
    expect(result.diagnostic.apiCanonicalCount).toBe(1);
    // Watermark advances over the canonical intersection only.
    expect(result.advance.t1).toBe(Date.parse('2026-04-26T10:00:00Z'));
  });

  it('reports canonical/non-canonical counts in diagnostic', () => {
    const ui = [msg('1', 't1', '2026-04-26T10:00:00Z'), msg('2', 't1', '2026-04-26T10:01:00Z')];
    const api = [msg('1', 't1', '2026-04-26T10:00:00Z'), msg('2', 't1', '2026-04-26T10:01:00Z')];
    const result = computeShadowComparison(ui, api, 'c');
    expect(result.diagnostic.uiCanonicalCount).toBe(2);
    expect(result.diagnostic.uiNonCanonicalCount).toBe(0);
    expect(result.diagnostic.apiCanonicalCount).toBe(2);
  });

  it('non-finite API timestamp does not contribute to advance', () => {
    const ui = [msg('1', 't1', '2026-04-26T10:00:00Z')];
    const api = [{ ...msg('1', 't1', '2026-04-26T10:00:00Z'), timestamp: 'not-a-date' }];
    const result = computeShadowComparison(ui, api, 'cyc');
    expect(result.advance).toEqual({});
  });
});
