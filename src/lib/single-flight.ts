import { performance } from 'node:perf_hooks';

export interface SingleFlightLease {
  operation: string;
  release: () => void;
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

export function __resetSingleFlightForTesting(): void {
  currentLock = null;
}
