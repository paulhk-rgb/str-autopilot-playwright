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

  // ===== v0.3 INBOX_READER_MODE wiring =====

  it('defaults INBOX_READER_MODE to ui when unset', () => {
    const env = readEnv(VALID as NodeJS.ProcessEnv);
    expect(env.INBOX_READER_MODE).toBe('ui');
  });

  it('parses shadow / api / ui modes case-insensitively', () => {
    const withUserId = { ...VALID, AIRBNB_API_USER_ID: '1234567' };
    expect(readEnv({ ...withUserId, INBOX_READER_MODE: 'shadow' } as NodeJS.ProcessEnv).INBOX_READER_MODE).toBe('shadow');
    expect(readEnv({ ...withUserId, INBOX_READER_MODE: 'API' } as NodeJS.ProcessEnv).INBOX_READER_MODE).toBe('api');
    expect(readEnv({ ...VALID, INBOX_READER_MODE: 'UI' } as NodeJS.ProcessEnv).INBOX_READER_MODE).toBe('ui');
  });

  it('falls back to ui mode for unknown INBOX_READER_MODE values', () => {
    expect(readEnv({ ...VALID, INBOX_READER_MODE: 'wat' } as NodeJS.ProcessEnv).INBOX_READER_MODE).toBe('ui');
  });

  it('throws when shadow mode is enabled without AIRBNB_API_USER_ID', () => {
    expect(() =>
      readEnv({ ...VALID, INBOX_READER_MODE: 'shadow' } as NodeJS.ProcessEnv),
    ).toThrow(/AIRBNB_API_USER_ID/);
  });

  it('throws when api mode is enabled without AIRBNB_API_USER_ID', () => {
    expect(() =>
      readEnv({ ...VALID, INBOX_READER_MODE: 'api' } as NodeJS.ProcessEnv),
    ).toThrow(/AIRBNB_API_USER_ID/);
  });

  it('auto-derives AIRBNB_API_GLOBAL_USER_ID from numeric AIRBNB_API_USER_ID', () => {
    const env = readEnv({
      ...VALID,
      INBOX_READER_MODE: 'shadow',
      AIRBNB_API_USER_ID: '1234567',
    } as NodeJS.ProcessEnv);
    expect(env.AIRBNB_API_USER_ID).toBe('1234567');
    // base64('Viewer:1234567')
    expect(env.AIRBNB_API_GLOBAL_USER_ID).toBe(Buffer.from('Viewer:1234567').toString('base64'));
  });

  it('uses pinned defaults for AIRBNB_API_KEY / inbox / thread hashes when unset', () => {
    const env = readEnv({
      ...VALID,
      INBOX_READER_MODE: 'api',
      AIRBNB_API_USER_ID: '7654321',
    } as NodeJS.ProcessEnv);
    expect(env.AIRBNB_API_KEY).toBe('d306zoyjsyarp7ifhu67rjxn52tv0t20');
    expect(env.AIRBNB_API_INBOX_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(env.AIRBNB_API_THREAD_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honors env-provided AIRBNB_API_INBOX_HASH (hash auto-recovery override)', () => {
    const fresh = 'feed'.repeat(16);
    const env = readEnv({
      ...VALID,
      INBOX_READER_MODE: 'api',
      AIRBNB_API_USER_ID: '7654321',
      AIRBNB_API_INBOX_HASH: fresh,
    } as NodeJS.ProcessEnv);
    expect(env.AIRBNB_API_INBOX_HASH).toBe(fresh);
  });

  it('rejects malformed AIRBNB_API_USER_ID (non-numeric → null → throws when mode!=ui)', () => {
    expect(() =>
      readEnv({
        ...VALID,
        INBOX_READER_MODE: 'shadow',
        AIRBNB_API_USER_ID: 'not-numeric',
      } as NodeJS.ProcessEnv),
    ).toThrow(/AIRBNB_API_USER_ID/);
  });

  it('WATERMARKS_PATH defaults to /data/profile/watermarks.json', () => {
    const env = readEnv(VALID as NodeJS.ProcessEnv);
    expect(env.WATERMARKS_PATH).toBe('/data/profile/watermarks.json');
  });

  it('WATERMARKS_PATH honors env override', () => {
    const env = readEnv({ ...VALID, WATERMARKS_PATH: '/tmp/wm.json' } as NodeJS.ProcessEnv);
    expect(env.WATERMARKS_PATH).toBe('/tmp/wm.json');
  });
});
