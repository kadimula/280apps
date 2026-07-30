// The gateway Worker entrypoint (wrangler `main`). Isolate holds only
// config-derived singletons; store + Auth are request-scoped and closed after
// the response.

import { newLogger } from '@280/backend/logger';
import { buildStatics, requestGateway, type GatewayStatics } from './deps.js';
import type { Env } from './config.js';

const log = newLogger('json');

// Lazy: buildStatics reads Env, which the runtime only provides inside fetch().
let statics: GatewayStatics | null = null;

function isolate(env: Env): GatewayStatics {
  if (statics === null) statics = buildStatics(env, log);
  return statics;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let s: GatewayStatics;
    try {
      s = isolate(env);
    } catch (err) {
      log.error('gateway is not configured', { error: err instanceof Error ? err.message : String(err) });
      return new Response('The gateway is not configured.\n', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const { gateway, close } = requestGateway(s);
    try {
      return await gateway.handle(request);
    } finally {
      const done = close().catch(() => {});
      try {
        ctx.waitUntil(done);
      } catch {
        void done;
      }
    }
  },
};
