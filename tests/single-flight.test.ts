import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireSingleFlightWithWait,
  tryAcquireSingleFlight,
  __resetSingleFlightForTesting,
} from '../src/lib/single-flight';

afterEach(() => {
  __resetSingleFlightForTesting();
});

describe('acquireSingleFlightWithWait', () => {
  it('acquires immediately when the lock is free', async () => {
    const lease = await acquireSingleFlightWithWait('op', { maxWaitMs: 1_000 });
    expect(lease).not.toBeNull();
    expect(lease?.operation).toBe('op');
    lease?.release();
  });

  it('returns null when the lock stays held past maxWaitMs', async () => {
    const holder = tryAcquireSingleFlight('holder');
    expect(holder).not.toBeNull();

    const startedAt = Date.now();
    const lease = await acquireSingleFlightWithWait('op', { maxWaitMs: 120, pollMs: 20 });
    const waited = Date.now() - startedAt;

    expect(lease).toBeNull();
    expect(waited).toBeGreaterThanOrEqual(100); // actually waited the window
    holder?.release();
  });

  it('acquires once the holder releases within the wait window', async () => {
    const holder = tryAcquireSingleFlight('holder');
    expect(holder).not.toBeNull();
    setTimeout(() => holder?.release(), 50);

    const lease = await acquireSingleFlightWithWait('op', { maxWaitMs: 1_000, pollMs: 15 });
    expect(lease).not.toBeNull();
    expect(lease?.operation).toBe('op');
    lease?.release();
  });

  it('a released lease frees the lock for the next waiter', async () => {
    const first = await acquireSingleFlightWithWait('a', { maxWaitMs: 100 });
    expect(first).not.toBeNull();
    first?.release();
    const second = await acquireSingleFlightWithWait('b', { maxWaitMs: 100 });
    expect(second).not.toBeNull();
    second?.release();
  });
});
