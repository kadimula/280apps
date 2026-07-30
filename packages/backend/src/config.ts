// Config and secrets for the Worker: the typed shape of the Cloudflare Env, and
// readConfig(), the one place raw bindings and vars turn into typed values. Nothing
// here reaches for process.env; every value comes off Env.

import type { Platform } from './deploysvc.js';
import type { Auth } from './authsvc.js';

// Env is a Worker's second argument: bindings (objects), wrangler `vars`, and
// Workers Secrets (both strings, absent ⇒ undefined), all on one object.
export interface Env {
  // Bindings (wrangler.jsonc).
  BLOBS: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  APP_ACTIVATOR: DurableObjectNamespace;

  // Non-secret tunables (wrangler `vars`).
  TWO80_RUNTIME?: string;
  TWO80_LOG_FORMAT?: string;
  TWO80_DB_SCHEMA?: string;
  TWO80_APP_DOMAIN?: string;
  TWO80_APP_HOST_SUFFIX?: string;
  TWO80_API_ORIGIN?: string;
  TWO80_FRONTEND_ORIGIN?: string;
  TWO80_VERIFICATION_URI?: string;
  TWO80_COOKIE_DOMAIN?: string;
  TWO80_OPEN_SIGNUP?: string;
  TWO80_MIN_CLI_VERSION?: string;
  TWO80_SESSION_TTL_DAYS?: string;
  TWO80_LOGIN_RATE_WINDOW_SECS?: string;
  TWO80_LOGIN_RATE_MAX?: string;
  CF_DISPATCH_NAMESPACE?: string;
  CF_ISR_CACHE_KV?: string;
  CF_COMPATIBILITY_DATE?: string;
  CF_D1_LOCATION?: string;

  // Secrets (`wrangler secret put`).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // The Neon origin Hyperdrive fronts. At runtime the Worker dials the pooled
  // HYPERDRIVE binding, so the store reads connectionString off that, not this.
  // Present for parity: the same secret the CI migrate runner reads out of band.
  DATABASE_URL?: string;
}

// Config is Env resolved: defaults applied, numbers parsed, secrets grouped. Built
// once per request (and per scheduled sweep).
export interface Config {
  runtime: 'cloudflare' | 'memory';
  logFormat: 'json' | 'text';
  dbSchema: string;
  // dbConnectionString is what the request's pg client dials: the Hyperdrive
  // pooled endpoint, not the raw Neon origin.
  dbConnectionString: string;
  appDomain: string;
  hostSuffix: string;
  apiOrigin: string;
  frontendOrigin: string;
  verificationUri: string;
  cookieDomain: string;
  openSignup: boolean;
  minCliVersion: string;
  sessionTtlDays: number;
  loginRate: { windowSecs: number; max: number };
  google: { clientId: string; clientSecret: string };
  cf: {
    accountId: string;
    apiToken: string;
    namespace: string;
    isrCacheKV: string;
    compatibilityDate: string;
    d1Location: string;
  };
}

// readConfig resolves Env into Config. Defaults mirror the deleted main.ts env()
// fallbacks byte for byte, so an unset var behaves exactly as it did on Node.
export function readConfig(env: Env): Config {
  const str = (v: string | undefined, fallback: string): string =>
    v !== undefined && v !== '' ? v : fallback;
  const num = (v: string | undefined, fallback: number): number => Number(str(v, String(fallback))) || fallback;

  return {
    runtime: str(env.TWO80_RUNTIME, 'cloudflare') === 'memory' ? 'memory' : 'cloudflare',
    logFormat: str(env.TWO80_LOG_FORMAT, 'text') === 'json' ? 'json' : 'text',
    dbSchema: str(env.TWO80_DB_SCHEMA, 'platform'),
    dbConnectionString: env.HYPERDRIVE.connectionString,
    appDomain: str(env.TWO80_APP_DOMAIN, '280apps.run'),
    hostSuffix: env.TWO80_APP_HOST_SUFFIX ?? '',
    apiOrigin: str(env.TWO80_API_ORIGIN, 'https://api.280apps.com'),
    frontendOrigin: str(env.TWO80_FRONTEND_ORIGIN, 'https://www.280apps.com'),
    verificationUri: str(env.TWO80_VERIFICATION_URI, 'https://280apps.com/activate'),
    cookieDomain: env.TWO80_COOKIE_DOMAIN ?? '',
    openSignup: env.TWO80_OPEN_SIGNUP === '1',
    minCliVersion: env.TWO80_MIN_CLI_VERSION ?? '',
    sessionTtlDays: num(env.TWO80_SESSION_TTL_DAYS, 30),
    loginRate: {
      windowSecs: num(env.TWO80_LOGIN_RATE_WINDOW_SECS, 600),
      max: num(env.TWO80_LOGIN_RATE_MAX, 30),
    },
    google: { clientId: env.GOOGLE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_CLIENT_SECRET ?? '' },
    cf: {
      accountId: env.CF_ACCOUNT_ID ?? '',
      apiToken: env.CF_API_TOKEN ?? '',
      namespace: env.CF_DISPATCH_NAMESPACE ?? '',
      isrCacheKV: env.CF_ISR_CACHE_KV ?? '',
      compatibilityDate: env.CF_COMPATIBILITY_DATE ?? '',
      d1Location: env.CF_D1_LOCATION ?? '',
    },
  };
}

// RequestDeps is the per-request I/O container the deps middleware builds from Env
// and puts on the context. Everything network-touching is built fresh here per
// request and never carried across requests.
export interface RequestDeps {
  platform: Platform;
  // Unset when no login provider is configured (a memory-runtime dev loop): the web
  // surface fails closed, the deploy API still serves.
  auth?: Auth;
  openSignup: boolean;
  verificationUri: string;
  minCliVersion: string;
  // Releases the request's pg client after the response, via ctx.waitUntil. Absent
  // for in-memory test wiring, whose shared store is closed once at teardown.
  close?: () => Promise<void>;
}
