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

const STALE_LOCK_MS = 6 * 60_000;

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
