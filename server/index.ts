import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// This file runs from server/ in dev (tsx) and from server/dist/ in production,
// so find the server package dir by walking up to its package.json.
let serverDir = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(serverDir, 'package.json'))) serverDir = dirname(serverDir);

// Relative paths (./public, ./db/migrations) are resolved against the
// working directory; pin it to server/ so `npm start` from the repo root, a
// systemd unit, etc. all behave exactly like `npm run dev`.
process.chdir(serverDir);

// Load .env from the project root (one level up from server/).
// Must run before any other import reads process.env.
const envFilePath = resolve(serverDir, '../.env');
loadEnv({ path: envFilePath });
process.env.KB_ENV_PATH = envFilePath;

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { loadConfig } from './lib/env.js';

/**
 * Bootstrap order is load-bearing:
 *   1. loadConfig()     — fail fast on bad env BEFORE anything reads it.
 *   2. runMigrations()  — bring the Postgres schema up to date before serving.
 *   3. dynamic import of db/client and routes.
 *
 * Why dynamic imports: ESM hoists static imports above the loadEnv() call at
 * the top of this file, and several modules read process.env at module load —
 * db/client.ts (DATABASE_URL, to build the pool), lib/session.ts
 * (SESSION_SECRET, validated on load), routes/auth.ts (credentials). Importing
 * them only after .env is loaded and validated keeps that working. No module
 * queries the database at load time; migrations just have to finish before
 * the server starts accepting requests.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const { pool, runMigrations } = await import('./db/client.js');
  await runMigrations();

  const { authRouter } = await import('./routes/auth.js');
  const { spacesRouter } = await import('./routes/spaces.js');
  const { pagesRouter } = await import('./routes/pages.js');
  const { searchRouter } = await import('./routes/search.js');
  const { calendarRouter } = await import('./routes/calendar.js');
  const { todosRouter } = await import('./routes/todos.js');

  const app = new Hono();

  app.use('*', logger());

  // ── API ──────────────────────────────────────────────────────────────────
  const api = new Hono();
  // auth is public (login/logout/me self-guard); the others guard themselves
  // via requireAuth applied inside each sub-router.
  api.route('/auth', authRouter);
  api.route('/spaces', spacesRouter);
  api.route('/pages', pagesRouter);
  api.route('/search', searchRouter);
  api.route('/calendar', calendarRouter);
  api.route('/todos', todosRouter);

  app.route('/api', api);

  // Centralized error handler — never leak internal/database error text.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error('[unhandled]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // ── Static + SPA fallback (production) ─────────────────────────────────────
  if (config.isProduction) {
    app.use('/*', serveStatic({ root: './public' }));
    // Any non-API, non-asset path falls back to the SPA shell.
    app.notFound(async (c) => {
      if (c.req.path.startsWith('/api')) {
        return c.json({ error: 'Not found' }, 404);
      }
      const res = await serveStatic({ path: './public/index.html' })(c, async () => {});
      return res ?? c.json({ error: 'Not found' }, 404);
    });
  } else {
    app.notFound((c) => c.json({ error: 'Not found' }, 404));
  }

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`dt-kb API listening on http://0.0.0.0:${info.port}`);
  });

  // Graceful shutdown (systemd stop, Ctrl+C, tsx watch restarts): stop taking
  // connections, then close the pool so Postgres sees clean disconnects rather
  // than dropped sockets. A timer forces the exit if a keep-alive socket or a
  // stuck query holds things open.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 5000).unref();
    server.close();
    pool.end().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('[db] error closing pool:', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
