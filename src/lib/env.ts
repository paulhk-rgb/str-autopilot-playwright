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
  /** API-reader configuration (v0.3 wiring). All fields populated from env vars
   *  with sane defaults when absent — staying in 'ui' mode keeps the new code
   *  path dead until shadow rollout is explicitly enabled. */
  INBOX_READER_MODE: 'ui' | 'shadow' | 'api';
  AIRBNB_API_USER_ID: string | null;            // numeric, e.g. "50758264"
  AIRBNB_API_GLOBAL_USER_ID: string | null;     // base64('Viewer:<numericId>')
  AIRBNB_API_KEY: string;                        // public web client key (default known)
  AIRBNB_API_INBOX_HASH: string;                 // pinned default per spec §3
  AIRBNB_API_THREAD_HASH: string;                // pinned default per spec §3
  WATERMARKS_PATH: string;                       // /data/profile/watermarks.json by default
}

/** Internal defaults — NOT env-configurable in production to stay within spec §5.1. */
const MACHINE_PORT = 8080;
const MACHINE_PROFILE_DIR = '/data/profile';

/** API-reader pinned defaults per spec §3. Each can be overridden via env to
 *  unblock the v0.3 hash-rotation recovery path without redeploying. */
const DEFAULT_AIRBNB_API_KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20'; // public web key
const DEFAULT_AIRBNB_API_INBOX_HASH =
  'ebeb240346015c12be36d76fd7003cbef5658e1c6d2e60b3554280b3c081aeea';
const DEFAULT_AIRBNB_API_THREAD_HASH =
  '9384287931cf3da66dd1fae72eb9d28e588de4066e05d34a657e30a9e9d2e9ef';
const DEFAULT_WATERMARKS_PATH = '/data/profile/watermarks.json';

function parseInboxReaderMode(raw: string | undefined): 'ui' | 'shadow' | 'api' {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'shadow') return 'shadow';
  if (v === 'api') return 'api';
  return 'ui'; // default
}

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

  // API-reader env vars (v0.3 wiring; all optional with safe fallbacks).
  const inboxReaderMode = parseInboxReaderMode(source.INBOX_READER_MODE);
  const airbnbUserIdRaw = (source.AIRBNB_API_USER_ID ?? '').trim();
  const airbnbUserId = airbnbUserIdRaw && /^\d{4,}$/.test(airbnbUserIdRaw) ? airbnbUserIdRaw : null;
  let airbnbGlobalUserId = (source.AIRBNB_API_GLOBAL_USER_ID ?? '').trim() || null;
  // If only the numeric ID is supplied, derive the base64-prefixed form.
  if (!airbnbGlobalUserId && airbnbUserId) {
    airbnbGlobalUserId = Buffer.from(`Viewer:${airbnbUserId}`).toString('base64');
  }
  // In non-ui modes, both API user IDs must be present — fail fast at startup.
  if (inboxReaderMode !== 'ui' && (!airbnbUserId || !airbnbGlobalUserId)) {
    throw new Error(
      `INBOX_READER_MODE=${inboxReaderMode} requires AIRBNB_API_USER_ID (numeric) ` +
        `and either AIRBNB_API_GLOBAL_USER_ID (base64) or auto-derivation from the numeric ID.`,
    );
  }
  const airbnbApiKey = (source.AIRBNB_API_KEY ?? '').trim() || DEFAULT_AIRBNB_API_KEY;
  const airbnbInboxHash = (source.AIRBNB_API_INBOX_HASH ?? '').trim() || DEFAULT_AIRBNB_API_INBOX_HASH;
  const airbnbThreadHash = (source.AIRBNB_API_THREAD_HASH ?? '').trim() || DEFAULT_AIRBNB_API_THREAD_HASH;
  const watermarksPath = (source.WATERMARKS_PATH ?? '').trim() || DEFAULT_WATERMARKS_PATH;

  return {
    HMAC_SECRET: hmac,
    HOST_ID: hostId,
    CALLBACK_URL: callbackUrl,
    PORT: MACHINE_PORT,
    PROFILE_DIR: MACHINE_PROFILE_DIR,
    INBOX_READER_MODE: inboxReaderMode,
    AIRBNB_API_USER_ID: airbnbUserId,
    AIRBNB_API_GLOBAL_USER_ID: airbnbGlobalUserId,
    AIRBNB_API_KEY: airbnbApiKey,
    AIRBNB_API_INBOX_HASH: airbnbInboxHash,
    AIRBNB_API_THREAD_HASH: airbnbThreadHash,
    WATERMARKS_PATH: watermarksPath,
  };
}
