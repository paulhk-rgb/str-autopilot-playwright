/**
 * Env var access — fail-fast on missing required vars at startup.
 * Per spec §5.1: machine receives ONLY HMAC_SECRET, HOST_ID, CALLBACK_URL.
 * NO SUPABASE_SERVICE_ROLE_KEY (debate fix Opus P0-5, Sonnet P0-4, Codex P0-3).
 */

export interface MachineEnv {
  HMAC_SECRET: string;
  HOST_ID: string;
  CALLBACK_URL: string;
  PORT: number;
  PROFILE_DIR: string;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): MachineEnv {
  const required = ['HMAC_SECRET', 'HOST_ID', 'CALLBACK_URL'] as const;
  const missing = required.filter((k) => !source[k] || source[k]!.trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. ` +
        'Per spec §5.1 these are injected at Fly machine provision time.',
    );
  }

  // HMAC_SECRET must be hex-encoded 32-byte secret (64 hex chars) per spec §2.4 step 0b.
  const hmac = source.HMAC_SECRET!.trim();
  if (!/^[0-9a-fA-F]+$/.test(hmac) || hmac.length < 32) {
    throw new Error('HMAC_SECRET must be a hex-encoded random secret (at least 16 bytes / 32 hex chars)');
  }

  const hostId = source.HOST_ID!.trim();
  if (!/^[0-9a-fA-F-]{8,}$/.test(hostId)) {
    throw new Error('HOST_ID must be a UUID');
  }

  const callbackUrl = source.CALLBACK_URL!.trim();
  try {
    const u = new URL(callbackUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('CALLBACK_URL must be http(s)');
    }
  } catch {
    throw new Error(`CALLBACK_URL is not a valid URL: ${callbackUrl}`);
  }

  const port = Number(source.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid integer: ${source.PORT}`);
  }

  const profileDir = source.PROFILE_DIR?.trim() || '/data/profile';

  return {
    HMAC_SECRET: hmac,
    HOST_ID: hostId,
    CALLBACK_URL: callbackUrl,
    PORT: port,
    PROFILE_DIR: profileDir,
  };
}
