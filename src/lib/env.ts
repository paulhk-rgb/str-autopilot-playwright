/**
 * Env var access — fail-fast on missing required vars at startup.
 * Per spec §5.1: machine receives ONLY HMAC_SECRET, HOST_ID, CALLBACK_URL.
 * NO SUPABASE_SERVICE_ROLE_KEY (debate fix Opus P0-5, Sonnet P0-4, Codex P0-3).
 */

/** Internal machine config — first 3 are from spec §5.1; rest are hardcoded runtime constants. */
export interface MachineEnv {
  HMAC_SECRET: string;
  HOST_ID: string;
  CALLBACK_URL: string;
  PORT: number;           // hardcoded 8080 per fly.toml internal_port
  PROFILE_DIR: string;    // hardcoded /data/profile (Fly volume mount target)
}

/** Internal defaults — NOT env-configurable in production to stay within spec §5.1. */
const MACHINE_PORT = 8080;
const MACHINE_PROFILE_DIR = '/data/profile';

/**
 * Env var names that MUST NEVER be present on a machine per spec §5.1.
 * Provisioning mistakes (e.g. copying staging `.env` to machine) are blocked at startup.
 */
const FORBIDDEN_ENV_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'FLY_API_TOKEN',
] as const;

export function readEnv(source: NodeJS.ProcessEnv = process.env): MachineEnv {
  // Codex P0-fix: reject any forbidden env var before touching required ones — a misprovisioned
  // machine that leaks service_role would otherwise boot successfully.
  const forbiddenFound = FORBIDDEN_ENV_VARS.filter((k) => source[k] && source[k]!.trim() !== '');
  if (forbiddenFound.length > 0) {
    throw new Error(
      `Forbidden env vars present on Fly machine: ${forbiddenFound.join(', ')}. ` +
        'Per spec §5.1 the machine receives ONLY HMAC_SECRET, HOST_ID, CALLBACK_URL. ' +
        'Machines communicate via HMAC-authed callbacks — no direct DB / API credentials.',
    );
  }

  const required = ['HMAC_SECRET', 'HOST_ID', 'CALLBACK_URL'] as const;
  const missing = required.filter((k) => !source[k] || source[k]!.trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. ` +
        'Per spec §5.1 these are injected at Fly machine provision time.',
    );
  }

  // HMAC_SECRET must be hex-encoded 32-byte secret (64 hex chars) per spec §2.4 step 0b:
  // `generated_per_host_secret = gen_random_bytes(32)` -> encode(hex) -> 64 hex chars.
  const hmac = source.HMAC_SECRET!.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hmac)) {
    throw new Error(
      'HMAC_SECRET must be a hex-encoded 32-byte random secret (exactly 64 hex chars) per spec §2.4 step 0b',
    );
  }

  const hostId = source.HOST_ID!.trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(hostId)) {
    throw new Error('HOST_ID must be a UUID (8-4-4-4-12 hex format)');
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

  return {
    HMAC_SECRET: hmac,
    HOST_ID: hostId,
    CALLBACK_URL: callbackUrl,
    PORT: MACHINE_PORT,
    PROFILE_DIR: MACHINE_PROFILE_DIR,
  };
}
