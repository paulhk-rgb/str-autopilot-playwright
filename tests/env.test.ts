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
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/64 hex chars/);
  });

  it('rejects short HMAC_SECRET (16 bytes / 32 hex)', () => {
    const env = { ...VALID, HMAC_SECRET: 'a'.repeat(32) };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/64 hex chars/);
  });

  it('rejects odd-length HMAC_SECRET', () => {
    const env = { ...VALID, HMAC_SECRET: 'a'.repeat(63) };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/64 hex chars/);
  });

  it('rejects malformed CALLBACK_URL', () => {
    const env = { ...VALID, CALLBACK_URL: 'not a url' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/CALLBACK_URL/);
  });

  it('rejects non-UUID HOST_ID', () => {
    const env = { ...VALID, HOST_ID: 'not-a-uuid' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/HOST_ID/);
  });

  it('rejects SUPABASE_SERVICE_ROLE_KEY (forbidden per spec §5.1)', () => {
    const env = { ...VALID, SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOi...' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/Forbidden env vars/);
  });

  it('rejects STRIPE_SECRET_KEY (forbidden per spec §5.1)', () => {
    const env = { ...VALID, STRIPE_SECRET_KEY: 'sk_test_...' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/Forbidden/);
  });

  it('rejects FLY_API_TOKEN (forbidden per spec §5.1)', () => {
    const env = { ...VALID, FLY_API_TOKEN: 'fm2_...' };
    expect(() => readEnv(env as NodeJS.ProcessEnv)).toThrow(/Forbidden/);
  });

  it('PORT is always 8080 (not env-configurable)', () => {
    const env = readEnv({ ...VALID, PORT: '9999' } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(8080);
  });

  it('PROFILE_DIR is always /data/profile (not env-configurable)', () => {
    const env = readEnv({ ...VALID, PROFILE_DIR: './override' } as NodeJS.ProcessEnv);
    expect(env.PROFILE_DIR).toBe('/data/profile');
  });
});
