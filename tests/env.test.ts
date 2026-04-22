import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/lib/env';

const VALID = {
  HMAC_SECRET: 'a'.repeat(64),
  HOST_ID: '11111111-2222-3333-4444-555555555555',
  CALLBACK_URL: 'https://staysync.example.com/api/playwright-callback',
};

describe('readEnv', () => {
  it('accepts a well-formed env', () => {
    const env = readEnv(VALID as NodeJS.ProcessEnv);
    expect(env.HOST_ID).toBe(VALID.HOST_ID);
    expect(env.HMAC_SECRET).toBe(VALID.HMAC_SECRET);
    expect(env.CALLBACK_URL).toBe(VALID.CALLBACK_URL);
    expect(env.PORT).toBe(8080);
    expect(env.PROFILE_DIR).toBe('/data/profile');
  });

  it('throws on missing HMAC_SECRET', () => {
    const env = { ...VALID, HMAC_SECRET: '' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/HMAC_SECRET/);
  });

  it('rejects non-hex HMAC_SECRET', () => {
    const env = { ...VALID, HMAC_SECRET: 'not-hex-garbage' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/hex-encoded/);
  });

  it('rejects malformed CALLBACK_URL', () => {
    const env = { ...VALID, CALLBACK_URL: 'not a url' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/CALLBACK_URL/);
  });

  it('rejects invalid PORT', () => {
    const env = { ...VALID, PORT: '99999' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('defaults PROFILE_DIR to /data/profile', () => {
    const env = readEnv(VALID as NodeJS.ProcessEnv);
    expect(env.PROFILE_DIR).toBe('/data/profile');
  });

  it('respects PROFILE_DIR override', () => {
    const env = readEnv({ ...VALID, PROFILE_DIR: './local-profile' } as NodeJS.ProcessEnv);
    expect(env.PROFILE_DIR).toBe('./local-profile');
  });
});
