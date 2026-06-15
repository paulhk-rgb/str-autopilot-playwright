import { performance } from 'node:perf_hooks';

export interface SingleFlightLease {
  operation: string;
  release: () => void;
}

export interface SingleFlightSnapshot {
  operation: string;
  elapsed_ms: number;
  stale_after_ms: number;
}

interface LockState {
  operation: string;
  startedAtMs: number;
  token: symbol;
}

// Pricing market scrapes can legitimately run close to the app-side 15 minute timeout.
// Keep the stale window longer than that so a long active scrape cannot self-clear its lock.
const STALE_LOCK_MS = 20 * 60_000;

let currentLock: LockState | null = null;

export function getSingleFlightSnapshot(): SingleFlightSnapshot | null {
  if (!currentLock) return null;
  const elapsedMs = Math.max(0, Math.round(performance.now() - currentLock.startedAtMs));
  return {
    operation: currentLock.operation,
    elapsed_ms: elapsedMs,
    stale_after_ms: STALE_LOCK_MS,
  };
}

export function tryAcquireSingleFlight(operation: string): SingleFlightLease | null {
  const now = performance.now();
  if (currentLock) {
    if (now - currentLock.startedAtMs <= STALE_LOCK_MS) {
      return null;
    }
    console.warn('[single-flight] stale lock cleared', {
      operation: currentLock.operation,
      elapsed_ms: Math.round(now - currentLock.startedAtMs),
    });
    currentLock = null;
  }

  const token = Symbol(operation);
  currentLock = { operation, startedAtMs: now, token };
  return {
    operation,
    release: () => {
      if (currentLock?.token === token) {
        currentLock = null;
      }
    },
  };
}

/**
 * Like `tryAcquireSingleFlight`, but instead of failing immediately when the
 * machine is busy it polls for the lock up to `maxWaitMs`. This lets two
 * legitimately-contending operations (a pricing market scrape and a message
 * sync share one machine + one global lock) serialize gracefully rather than
 * 409-ing each other: the later arrival waits for the in-flight op to release.
 *
 * Bounded on purpose — the caller's own request deadline must still cover
 * `maxWaitMs` + the operation's own runtime, so a pathologically long holder
 * still yields a null (→ 409) the caller can retry, never an unbounded hang.
 */
export async function acquireSingleFlightWithWait(
  operation: string,
  opts: { maxWaitMs: number; pollMs?: number },
): Promise<SingleFlightLease | null> {
  const pollMs = Math.max(25, opts.pollMs ?? 200);
  const deadline = performance.now() + Math.max(0, opts.maxWaitMs);
  for (;;) {
    const lease = tryAcquireSingleFlight(operation);
    if (lease) return lease;
    if (performance.now() >= deadline) return null;
    const remaining = deadline - performance.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, remaining))));
  }
}

export function __resetSingleFlightForTesting(): void {
  currentLock = null;
}
