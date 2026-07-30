// The 280-platform Worker entrypoint: serves HTTP API v1 and runs the scheduled
// cleanup. The Hono router is the isolate's only singleton; everything I/O is
// request-scoped (api.ts withDeps builds a fresh deps container per request, and the
// pg client is closed after the response via ctx.waitUntil). Activation runs in the
// AppActivator Durable Object, not inline: the request landing the last blob only
// enqueues it, so its 204 ships before the app goes live.

import { Server } from './api.js';
import { buildRequestDeps, sweepExpired } from './deps.js';
import { newPgStore } from './store/store.js';
import { readConfig, type Env } from './config.js';
import { newLogger } from './logger.js';

// AppActivator is bound by the wrangler config and ships in this same Worker script,
// so it sees the same Env (Hyperdrive, R2, CF secrets) the request path reads.
export { AppActivator } from './app-activator.js';

// The isolate singletons: one JSON logger and one router. The router closes over
// buildDeps, which reads c.env per request, so it holds logic, never a connection.
const log = newLogger('json');
const app = new Server({
  buildDeps: (c) => buildRequestDeps(c.env, log),
  logger: log,
}).handler();

export default {
  // fetch runs the singleton router, threading env (bindings) and ctx (the pg
  // client's close lifetime) into the Hono context.
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  // scheduled runs the cleanup sweep on the cron trigger, building its own
  // request-scoped store and ending it when done.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = readConfig(env);
    const store = newPgStore(config.dbConnectionString, config.dbSchema);
    try {
      await sweepExpired(store, log, Math.floor(Date.now() / 1000));
    } catch (err) {
      log.error('scheduled cleanup failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      await store.close();
    }
  },
};
