// The 280-platform entrypoint: serves HTTP API v1 and activates deploys onto
// the runtime. It is the control plane; user apps do not run in this process.
//
// Spec: platform/cmd/280-platform/main.go. This is the assembly point of the
// package: it wires the store and blob store (W4) and the runtime (W6) into the
// Platform and Server, then runs a Node HTTP server whose timeouts are sized to
// cover a full Cloudflare activation, which runs inside the request that lands
// the last blob (plan risk register).

import { serve } from '@hono/node-server';
import type { Server as NodeHttpServer } from 'node:http';
import { Platform } from './deploysvc.js';
import { Server } from './api.js';
import { Auth } from './authsvc.js';
import { GoogleProvider, type OidcProvider } from './auth/oidc.js';
import type { Logger } from './observe.js';
import type { Runtime, Store } from './seams.js';
import { open as openStore } from './store/index.js';
import { open as openBlobStore } from './blobstore/index.js';
import { MemoryRuntime, cloudflare } from './runtime/index.js';

export async function main(): Promise<void> {
  const log = newLogger();
  try {
    await run(log);
  } catch (err) {
    log.error('fatal', { error: errText(err) });
    process.exitCode = 1;
  }
}

async function run(log: Logger): Promise<void> {
  const addr = listenAddr();

  // The schema, not the database, is what separates the platform's tables from
  // whatever else shares the instance.
  const db = await openStore(process.env.DATABASE_URL ?? '', env('TWO80_DB_SCHEMA', 'platform'));

  const blobs = await openBlobStore(env('TWO80_BLOBS', 'data/blobs'));

  const runtime = selectRuntime(log);

  const platform = new Platform({
    store: db,
    blobs,
    runtime,
    appDomain: env('TWO80_APP_DOMAIN', '280apps.run'),
    // Deliberate divergence from Go's env list (plan §1): a first-level host
    // suffix so staging can serve "<host>-staging.280apps.run" under free SSL.
    // Unset ⇒ empty ⇒ byte-identical to Go.
    hostSuffix: process.env.TWO80_APP_HOST_SUFFIX ?? '',
  });

  const auth = buildAuth(db, log);

  const server = new Server({
    platform,
    logger: log,
    openSignup: process.env.TWO80_OPEN_SIGNUP === '1',
    verificationUri: env('TWO80_VERIFICATION_URI', 'https://280apps.com/activate'),
    auth,
    // Unset serves every CLI. Set this only to retire binaries the API can no
    // longer talk to.
    minCliVersion: process.env.TWO80_MIN_CLI_VERSION ?? '',
  });

  const app = server.handler();
  const { host, port } = addr;

  await new Promise<void>((resolve, reject) => {
    const node = serve({ fetch: app.fetch, hostname: host, port }, () => {
      log.info('280 platform listening', { addr: display(addr), appDomain: platform.appDomain });
    }) as NodeHttpServer;

    // Activation runs inside the request that lands the last blob, so the request
    // timeout has to cover a full runtime deploy (Go WriteTimeout was 3m).
    node.requestTimeout = 6 * 60 * 1000;
    node.headersTimeout = 20 * 1000;

    node.on('error', reject);

    const shutdown = () => {
      log.info('shutting down');
      node.close((err) => (err ? reject(err) : resolve()));
      // Force-exit if connections linger past the grace window.
      setTimeout(() => resolve(), 30 * 1000).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

// buildAuth wires the browser-login flow, or returns undefined when no provider
// is configured. Undefined is not fatal: a memory-runtime dev loop with no
// Google credentials still serves the deploy API. But the web surface (login,
// the dashboard, activate) is inert without it, so it is called out.
function buildAuth(store: Store, log: Logger): Auth | undefined {
  const providers: Record<string, OidcProvider> = {};

  const googleId = process.env.GOOGLE_CLIENT_ID ?? '';
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  if (googleId !== '' && googleSecret !== '') {
    providers.google = new GoogleProvider({ clientId: googleId, clientSecret: googleSecret });
  }

  if (Object.keys(providers).length === 0) {
    log.warn('no login provider configured (set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET): the web surface cannot sign anyone in');
    return undefined;
  }

  const ttlDays = Number(env('TWO80_SESSION_TTL_DAYS', '30')) || 30;
  return new Auth(store, {
    providers,
    // Where Google sends the browser back; must match the console's redirect URI.
    apiOrigin: env('TWO80_API_ORIGIN', 'https://api.280apps.com'),
    // The only origin a post-login redirect may land on.
    frontendOrigin: env('TWO80_FRONTEND_ORIGIN', 'https://www.280apps.com'),
    // Empty is host-only (localhost dev); ".280apps.com" shares the cookie
    // between api and www in production.
    cookieDomain: process.env.TWO80_COOKIE_DOMAIN ?? '',
    sessionTtlSecs: ttlDays * 24 * 60 * 60,
    rate: {
      windowSecs: Number(env('TWO80_LOGIN_RATE_WINDOW_SECS', '600')) || 600,
      max: Number(env('TWO80_LOGIN_RATE_MAX', '30')) || 30,
    },
  });
}

// selectRuntime picks where apps run. Misconfiguration is a startup failure
// rather than a degraded mode: a platform that accepts pushes and hosts nothing
// is the one outcome with no honest error message for the agent.
function selectRuntime(log: Logger): Runtime {
  if (env('TWO80_RUNTIME', 'cloudflare') === 'memory') {
    log.warn('runtime=memory: deploys will be recorded but nothing will be hosted');
    return new MemoryRuntime();
  }
  const accountId = process.env.CF_ACCOUNT_ID ?? '';
  const apiToken = process.env.CF_API_TOKEN ?? '';
  const namespace = process.env.CF_DISPATCH_NAMESPACE ?? '';
  const isrCacheKV = process.env.CF_ISR_CACHE_KV ?? '';
  for (const [name, v] of [
    ['CF_ACCOUNT_ID', accountId],
    ['CF_API_TOKEN', apiToken],
    ['CF_DISPATCH_NAMESPACE', namespace],
  ] as const) {
    if (v === '') {
      throw new Error(`${name} is required (or set TWO80_RUNTIME=memory)`);
    }
  }
  if (isrCacheKV === '') {
    log.warn('CF_ISR_CACHE_KV unset: Next.js ISR will not persist between requests');
  }
  log.info('runtime=cloudflare', { namespace });
  return new cloudflare.Runtime({
    accountId,
    apiToken,
    namespace,
    isrCacheKV,
    compatibilityDate: process.env.CF_COMPATIBILITY_DATE ?? '',
    d1Location: process.env.CF_D1_LOCATION ?? '',
  });
}

// ---- listen address ----

interface Addr {
  host: string;
  port: number;
}

// listenAddr honors PORT, which is how every container host says where to listen.
// TWO80_ADDR stays for the local loop, where binding an interface matters more
// than a port.
function listenAddr(): Addr {
  const p = process.env.PORT;
  if (p) return { host: '0.0.0.0', port: Number(p) };
  return parseAddr(env('TWO80_ADDR', ':8080'));
}

function parseAddr(s: string): Addr {
  const i = s.lastIndexOf(':');
  const host = i > 0 ? s.slice(0, i) : '0.0.0.0';
  const port = Number(s.slice(i + 1));
  return { host, port };
}

function display(a: Addr): string {
  return `${a.host}:${a.port}`;
}

// ---- logging ----

// newLogger picks the log format. Text is the local loop, where a human reads
// the lines as they scroll past. JSON is anywhere the lines are shipped to be
// queried, which is the only way the access log answers "which pushes failed".
export function newLogger(): Logger {
  const json = env('TWO80_LOG_FORMAT', 'text') === 'json';
  return json ? jsonLogger() : textLogger();
}

function jsonLogger(): Logger {
  const emit = (level: string, msg: string, attrs?: Record<string, unknown>) => {
    const rec: Record<string, unknown> = { time: new Date().toISOString(), level, msg, ...attrs };
    process.stderr.write(JSON.stringify(rec) + '\n');
  };
  return {
    info: (m, a) => emit('INFO', m, a),
    warn: (m, a) => emit('WARN', m, a),
    error: (m, a) => emit('ERROR', m, a),
  };
}

function textLogger(): Logger {
  const emit = (level: string, msg: string, attrs?: Record<string, unknown>) => {
    const tail = attrs
      ? ' ' +
        Object.entries(attrs)
          .map(([k, v]) => `${k}=${format(v)}`)
          .join(' ')
      : '';
    process.stderr.write(`${new Date().toISOString()} ${level} ${msg}${tail}\n`);
  };
  return {
    info: (m, a) => emit('INFO', m, a),
    warn: (m, a) => emit('WARN', m, a),
    error: (m, a) => emit('ERROR', m, a),
  };
}

function format(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  return String(v);
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run when invoked as the entrypoint, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
