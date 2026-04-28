/**
 * str-autopilot-playwright — Fly machine server.
 * Spec: ~/str-autopilot/specs/DAY4-integration-patterns.md §2.4, §2.6, §2.7, §5.1
 *
 * Per-host Airbnb automation machine. One Fly machine per StaySync host.
 * Private networking only (6PN) — no public IP. HMAC-authed endpoints.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { readEnv } from './lib/env';
import { verifyHmacRequest } from './lib/hmac';
import { healthHandler } from './endpoints/health';
import { injectCookiesHandler } from './endpoints/inject-cookies';
import { syncHandler } from './endpoints/sync';
import { scrapeReservationListHandler } from './endpoints/scrape-reservation-list';
import { closeBrowserContext } from './playwright/browser';

function buildApp(env: ReturnType<typeof readEnv>) {
  const app = express();

  // Capture raw body bytes for HMAC verification BEFORE JSON parsing destroys them.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        // Stash the exact bytes that came over the wire. HMAC is over bytes, not the parsed tree.
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  // /health is unauthenticated — Fly health checker hits this every 30s.
  app.get('/health', healthHandler(env));

  // HMAC middleware — applied to authenticated routes only.
  const hmacAuth = (req: Request, res: Response, next: NextFunction): void => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const result = verifyHmacRequest({
      method: req.method,
      path: req.path,
      bodyBytes: raw,
      headers: {
        signature: req.headers['x-signature'] as string | undefined,
        timestamp: req.headers['x-timestamp'] as string | undefined,
        nonce: req.headers['x-nonce'] as string | undefined,
        hostId: req.headers['x-host-id'] as string | undefined,
        bodyHash: req.headers['x-body-hash'] as string | undefined,
      },
      secretHex: env.HMAC_SECRET,
      expectedHostId: env.HOST_ID,
    });

    if (!result.ok) {
      // Log diagnostic reason server-side, but don't leak it in the response body.
      // eslint-disable-next-line no-console
      console.warn(`HMAC verify failed: ${result.reason ?? 'unknown'}`);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.post('/inject-cookies', hmacAuth, injectCookiesHandler(env));
  app.post('/sync', hmacAuth, syncHandler(env));
  app.post('/scrape-reservation-list', hmacAuth, scrapeReservationListHandler(env));

  // 404 for anything else — Fly's private-network layer already drops public traffic.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Error handler — handle Express body-parser errors distinctly from unexpected failures.
  // Codex P1 fix: malformed/oversized JSON previously fell through to a generic 500; classify
  // body errors as 400/413 so we never conflate client fault with machine fault.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    const e = err as { type?: string; status?: number; statusCode?: number } | undefined;
    const status = e?.status ?? e?.statusCode;

    // express.json() sets err.type = 'entity.parse.failed' on malformed JSON,
    // 'entity.too.large' on oversized payloads, 'charset.unsupported' on bad charset.
    if (status === 400 || e?.type === 'entity.parse.failed' || e?.type === 'charset.unsupported') {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    if (status === 413 || e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }

    // eslint-disable-next-line no-console
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

async function main(): Promise<void> {
  const env = readEnv();
  const app = buildApp(env);

  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`str-autopilot-playwright listening on :${env.PORT} for host ${env.HOST_ID}`);
  });

  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Received ${sig} — shutting down`);
    server.close();
    await closeBrowserContext();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    // eslint-disable-next-line no-console
    console.error('Unhandled rejection:', err);
  });
}

// Only run main when executed directly (keeps buildApp importable for tests).
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

export { buildApp };
