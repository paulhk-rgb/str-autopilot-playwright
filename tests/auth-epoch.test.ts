import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetAuthEpochForTesting,
  beginCookieInject,
  currentAuthEpoch,
  isAuthEpochReady,
  markAuthEpochReady,
} from '../src/playwright/auth-epoch';

describe('AuthEpoch', () => {
  beforeEach(() => {
    _resetAuthEpochForTesting();
  });

  it('starts at counter=0, ready=false', () => {
    expect(currentAuthEpoch()).toBe(0);
    expect(isAuthEpochReady()).toBe(false);
  });

  it('beginCookieInject increments counter and sets ready=false', () => {
    markAuthEpochReady();
    expect(isAuthEpochReady()).toBe(true);
    const next = beginCookieInject();
    expect(next).toBe(1);
    expect(currentAuthEpoch()).toBe(1);
    expect(isAuthEpochReady()).toBe(false);
  });

  it('markAuthEpochReady flips ready=true without changing counter', () => {
    beginCookieInject(); // counter=1, ready=false
    expect(isAuthEpochReady()).toBe(false);
    markAuthEpochReady();
    expect(isAuthEpochReady()).toBe(true);
    expect(currentAuthEpoch()).toBe(1);
  });

  it('counter is monotonic — multiple injects only go up', () => {
    expect(beginCookieInject()).toBe(1);
    expect(beginCookieInject()).toBe(2);
    expect(beginCookieInject()).toBe(3);
    expect(currentAuthEpoch()).toBe(3);
  });

  it('mid-cycle rotation detection: counter at start vs after a new beginCookieInject', () => {
    markAuthEpochReady();
    const startEpoch = currentAuthEpoch();
    beginCookieInject(); // simulates /inject-cookies arriving mid-cycle
    expect(currentAuthEpoch()).not.toBe(startEpoch);
    expect(isAuthEpochReady()).toBe(false);
  });
});
