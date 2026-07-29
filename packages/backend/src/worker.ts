// The 280-platform Worker entrypoint: serves HTTP API v1 and runs the scheduled
// cleanup. It is the control plane; user apps do not run in this isolate.
//
// This replaces the deleted Node bootstrap (main.ts). The lifecycle rule is that
// the Hono router is the isolate's only singleton — built once here — and
// everything that does I/O is request-scoped: a leading middleware (api.ts
// withDeps) builds a fresh deps container from Env per request, and the pg
// client it holds is closed after the response via ctx.waitUntil. No I/O object
// is ever carried across requests.
//
// Accepted phase-1a limitation: activation still runs INLINE in the request that
// lands the last blob (deploysvc settle), NOT in the AppActivator Durable
// Object. AppActivator is a no-op stub here so the merged wrangler config (which
// declares the class + migration tag v1) can deploy; the real per-app activation
// DO that provides cross-isolate serialization is a later wave.

import { Server } from './api.js';
import { buildRequestDeps, sweepExpired } from './deps.js';
import { newPgStore } from './store/store.js';
import { readConfig, type Env } from './config.js';
import { newLogger } from './logger.js';

// The isolate singletons: one JSON logger (Workers Logs captures console.*) and
// one router. The router closes over buildDeps, which reads c.env per request —
// so the singleton holds config-reading logic, never a connection.
const log = newLogger('json');
const app = new Server({
  buildDeps: (c) => buildRequestDeps(c.env, log),
  logger: log,
}).handler();

export default {
  // fetch runs the singleton router. app.fetch threads env (the bindings the
  // deps middleware reads) and ctx (the lifetime the pg client's close is
  // scheduled on) into the Hono context.
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  // scheduled runs the cleanup sweep on the cron trigger: expired sessions and
  // device codes and lapsed login-rate windows. Invisible on the wire. It builds
  // its own request-scoped store and ends it when done. There is no queue()
  // handler.
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

// AppActivator is a no-op Durable Object stub. The merged wrangler config
// declares this class with migration tag v1, so the Worker will not deploy
// unless the class is exported — but phase 1a runs activation INLINE in the
// request (deploysvc settle), NOT in this DO, so nothing addresses it yet. The
// real per-app activation DO (cross-isolate serialization) is the next wave; do
// not add behavior here.
export class AppActivator {
  constructor(_state: DurableObjectState, _env: Env) {}
}
