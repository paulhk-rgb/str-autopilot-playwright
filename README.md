# str-autopilot-playwright

Per-host Airbnb automation machine image for [StaySync SaaS](https://github.com/paulhk-rgb/staysync-app).

One Fly.io machine runs per paying StaySync host. Each machine owns a persistent Chromium
profile with that host's Airbnb session cookies and exposes a small HMAC-authed HTTP API
(`/health`, `/inject-cookies`, `/sync`) on Fly's 6PN private network — no public IP.

**Spec:** `~/str-autopilot/specs/DAY4-integration-patterns.md` §2.4, §2.6, §2.7, §5.1.

---

## Architecture

```
                 HMAC-signed
    staysync-app  ----------->  Fly machine  ----------->  www.airbnb.com
    Edge Functions  (6PN)       (this repo)                (Playwright)
         ^                           |
         |   HMAC-signed             |
         +---------------------------+
           /api/playwright-callback
           (sync_messages_batch, send_result)
```

Machines have **no direct DB access**. All mutations flow back through HMAC-authed callbacks to
`{staysync-app}/api/playwright-callback`, which runs with `service_role` internally.

Per spec §5.1, a machine receives **exactly three env vars** at provision time:

- `HMAC_SECRET` — hex-encoded per-host secret (generated at provision time, stored encrypted in `playwright_sessions.hmac_secret_encrypted`).
- `HOST_ID` — UUID of the StaySync host this machine serves.
- `CALLBACK_URL` — Edge Function URL for callbacks (e.g. `https://xxx.supabase.co/functions/v1/playwright-callback`).

No `SUPABASE_SERVICE_ROLE_KEY` is ever injected into the machine (debate fix — Opus P0-5, Sonnet P0-4, Codex P0-3).

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Fly health checker + staysync-app `playwright-health-monitor` cron |
| `POST` | `/inject-cookies` | HMAC | Load Airbnb session cookies, verify against `playwright_sessions.airbnb_user_id` (cross-tenant check, §2.4 step 4b) |
| `POST` | `/sync` | HMAC | Scrape inbox + post paginated `sync_messages_batch` callbacks (§2.7) |

Deferred to future PRs: `/send`, `/screenshot`, `/clear-session`.

### HMAC scheme (spec §2.6)

Canonical message:

```
{method}\n{path}\n{timestamp}\n{nonce}\n{host_id}\n{body_sha256}
```

Headers required on every authed request:

- `X-Signature` — hex HMAC-SHA256 of the canonical message
- `X-Timestamp` — Unix epoch **seconds** (not ISO8601 — R2 fix Gemini P1-3)
- `X-Nonce` — per-request UUIDv4
- `X-Host-Id` — must match the machine's own `HOST_ID` env var
- `X-Body-Hash` (optional, validated if present) — hex SHA-256 of the raw body bytes

Machine verification rejects with `401` on: missing headers, timestamp drift >60s, host_id mismatch, body tamper, or signature mismatch (constant-time compare).

Replay protection is handled by the **callback verifier in staysync-app** (nonce INSERT into `runtime_state` with `ON CONFLICT (host_id, key) DO NOTHING`). The machine itself GENERATES nonces on outbound callbacks; it doesn't track inbound nonce replay (spec §2.6 note).

---

## Local development

```bash
npm install

# Provide the three runtime env vars + a local profile dir:
export HMAC_SECRET="$(openssl rand -hex 32)"
export HOST_ID="11111111-2222-3333-4444-555555555555"
export CALLBACK_URL="http://localhost:54321/functions/v1/playwright-callback"
export PROFILE_DIR="./data/profile"

npm run dev            # tsx watch server.ts
```

### Tests

```bash
npm test               # HMAC + env unit tests (vitest)
npm run typecheck      # tsc --noEmit
```

### Docker build

```bash
docker build -t str-autopilot-playwright-test .
```

---

## Deploy to Fly.io

**Prerequisites:**
- `flyctl` installed and authed (`/Users/paulkriegstein/.fly/bin/flyctl auth whoami`)
- App already created: `flyctl apps create str-autopilot-playwright --org personal`

**This repo does NOT auto-deploy.** Per spec §2.4, production machines are created one-per-host
by the staysync-app provisioner Inngest function, not by humans running `fly deploy`. However, the
base image (`registry.fly.io/str-autopilot-playwright:<tag>`) needs to be built and pushed by hand
(or CI) from this repo — the provisioner references it when spawning per-host VMs.

**Build + push image:**

```bash
cd ~/str-autopilot-playwright

# Auth the local Docker daemon against Fly's registry:
flyctl auth docker

# Build + tag + push:
TAG="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
docker build -t registry.fly.io/str-autopilot-playwright:$TAG .
docker push registry.fly.io/str-autopilot-playwright:$TAG

# Update the staysync-app provisioner config to reference the new digest:
docker inspect --format='{{index .RepoDigests 0}}' registry.fly.io/str-autopilot-playwright:$TAG
# -> paste the returned digest into the fly_machine_image config in staysync-app
```

**Validate `fly.toml`:**

```bash
/Users/paulkriegstein/.fly/bin/flyctl config validate --config fly.toml
```

### Machine provisioning (automated, per host)

The Inngest function `playwright-session-provision` in staysync-app calls Fly's Machines API
with a config like (spec §2.4 step 1):

```json
{
  "name": "pw-<host_id_short>",
  "config": {
    "image": "registry.fly.io/str-autopilot-playwright@sha256:<digest>",
    "guest": { "cpus": 1, "memory_mb": 512 },
    "env": {
      "HOST_ID": "<uuid>",
      "CALLBACK_URL": "<supabase-edge-url>",
      "HMAC_SECRET": "<hex>"
    },
    "services": [{ "internal_port": 8080, "ports": [{ "port": 8080, "handlers": ["http"] }], "protocol": "tcp" }],
    "restart": { "policy": "on-failure", "max_retries": 3 },
    "checks": { "health": { "type": "http", "port": 8080, "path": "/health", "interval": "30s", "timeout": "5s" } }
  },
  "region": "iad"
}
```

---

## Deferred / not in this PR

- `/send` endpoint — pending staysync-app `message-deliver-via-playwright` Inngest saga.
- `/screenshot` endpoint — debugging only, no urgency.
- Real Airbnb inbox scraper — `src/endpoints/sync.ts` ships the HMAC + callback-batching plumbing
  but uses a stub scraper. Follow-up PR will port the proven DOM selectors from
  `~/google-scripts/airbnb/playwright-sender/`.
- Fly volume for persistent profile — mount `/data` to a volume in production; local dev uses `./data`.

---

## License

MIT — see [LICENSE](LICENSE).
