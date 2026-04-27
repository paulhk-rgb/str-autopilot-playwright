/**
 * AuthEpoch — sidecar-global monotonic counter coupling /inject-cookies to read cycles.
 *
 * Per spec §2 invariant 7-8 + ADR-007: a read cycle that begins under one set of
 * cookies must abort if the cookies are rotated mid-flight. The counter is bumped
 * by /inject-cookies BEFORE writing the new cookies, then `ready` is flipped to
 * true only after the post-cookie-inject reload lands on /hosting/messages
 * (NOT /login).
 *
 * Reader contract: pre-cycle, check `ready === true` (skip if false). Record the
 * counter value at cycle start; abort emission if it changes mid-cycle.
 */

interface AuthEpochState {
  counter: number;
  ready: boolean;
}

let state: AuthEpochState = { counter: 0, ready: false };

export function currentAuthEpoch(): number {
  return state.counter;
}

export function isAuthEpochReady(): boolean {
  return state.ready;
}

/**
 * Called by /inject-cookies BEFORE writing the new cookies. Increments the counter
 * (so any in-flight reader will detect mid-cycle rotation) and clears `ready`
 * (so subsequent cycles skip until the post-reload URL check passes).
 */
export function beginCookieInject(): number {
  state = { counter: state.counter + 1, ready: false };
  return state.counter;
}

/**
 * Called by /inject-cookies AFTER `page.reload()` returns AND `page.url()` is
 * verified to match /hosting or /hosting/messages (NOT /login). Flips `ready`
 * to true so the next read cycle can proceed.
 */
export function markAuthEpochReady(): void {
  state = { ...state, ready: true };
}

/**
 * Test-only helper. Resets state for unit tests; not used in production paths.
 */
export function _resetAuthEpochForTesting(): void {
  state = { counter: 0, ready: false };
}
