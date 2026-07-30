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
  // TWO80_BUILD_HOST is the self-hosted Docker build host the container runtime
  // ships build contexts to; the control plane runs on Workers and cannot build
  // images itself. Empty unless TWO80_RUNTIME=memory.
  TWO80_BUILD_HOST?: string;
  // TWO80_BUILDER selects the build home: 'http' (the self-hosted Docker build
  // host, the default) or 'depot' (managed remote BuildKit). Unset falls back to
  // 'depot' only when DEPOT_TOKEN is present, else 'http' — so a host with no Depot
  // env keeps its current behavior.
  TWO80_BUILDER?: string;
  // DEPOT_PROJECT_ID pins every Depot build to one project (isolated layer cache).
  // Unset resolves a project per app via the Depot API.
  DEPOT_PROJECT_ID?: string;
  // CLOUDFLARE_ACCOUNT_ID is the registry.cloudflare.com username and the account
  // the app's container application rolls under.
  CLOUDFLARE_ACCOUNT_ID?: string;
  // TWO80_WORKER_ENTRY is the App280Container harness Worker the generated roll
  // config points `main` at; supplied by the runtime image, not the app source.
  TWO80_WORKER_ENTRY?: string;

  // Secrets (`wrangler secret put`).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // TWO80_BUILD_TOKEN authenticates the control plane to the build host.
  TWO80_BUILD_TOKEN?: string;
  // DEPOT_TOKEN is the Depot organization token authorizing remote builds.
  DEPOT_TOKEN?: string;
  // CLOUDFLARE_API_TOKEN pushes the built image to registry.cloudflare.com and
  // authorizes the wrangler roll. Required for the depot builder.
  CLOUDFLARE_API_TOKEN?: string;
  // DATABASE_URL is the Neon origin string Hyperdrive fronts; at runtime the
  // Worker dials the pooled HYPERDRIVE binding, so the store reads
  // connectionString off that, not this. Present for parity — it is the same
  // secret the CI migrate runner reads (from process.env, out of band).
  DATABASE_URL?: string;
}

// Config is Env resolved: defaults applied, numbers parsed, secrets grouped. Built
// once per request (and per scheduled sweep).
export interface Config {
  runtime: 'container' | 'memory';
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
  // builder selects which ContainerBuilder the runtime constructs.
  builder: 'http' | 'depot';
  // build is the self-hosted Docker build host the http builder calls.
  build: { host: string; token: string };
  // depot is the managed remote BuildKit build home (used when builder='depot').
  depot: { token: string; projectId: string };
  // cloudflare authenticates the registry push and the wrangler roll (depot builder).
  cloudflare: { accountId: string; apiToken: string };
  // workerEntry is the App280Container harness Worker the roll config references.
  workerEntry: string;
}

// ConfigVars is the string-keyed subset of tunables and secrets both hosts share:
// the Worker reads them off Env, the Node entrypoint off process.env (which
// satisfies this structurally). Only the bindings (BLOBS/HYPERDRIVE/APP_ACTIVATOR)
// and the source of dbConnectionString differ between the two.
export type ConfigVars = Omit<Env, 'BLOBS' | 'HYPERDRIVE' | 'APP_ACTIVATOR'>;

// resolveConfig turns raw vars into typed Config. Defaults mirror the deleted
// main.ts env() fallbacks byte for byte, so an unset var behaves exactly as it did
// on Node. dbConnectionString is injected because its source differs: the Worker
// dials the pooled Hyperdrive endpoint, Node dials DATABASE_URL directly.
export function resolveConfig(vars: ConfigVars, dbConnectionString: string): Config {
  const str = (v: string | undefined, fallback: string): string =>
    v !== undefined && v !== '' ? v : fallback;
  const num = (v: string | undefined, fallback: number): number => Number(str(v, String(fallback))) || fallback;

  return {
    runtime: str(vars.TWO80_RUNTIME, 'container') === 'memory' ? 'memory' : 'container',
    logFormat: str(vars.TWO80_LOG_FORMAT, 'text') === 'json' ? 'json' : 'text',
    dbSchema: str(vars.TWO80_DB_SCHEMA, 'platform'),
    dbConnectionString,
    appDomain: str(vars.TWO80_APP_DOMAIN, '280apps.run'),
    hostSuffix: vars.TWO80_APP_HOST_SUFFIX ?? '',
    apiOrigin: str(vars.TWO80_API_ORIGIN, 'https://api.280apps.com'),
    frontendOrigin: str(vars.TWO80_FRONTEND_ORIGIN, 'https://www.280apps.com'),
    verificationUri: str(vars.TWO80_VERIFICATION_URI, 'https://280apps.com/activate'),
    cookieDomain: vars.TWO80_COOKIE_DOMAIN ?? '',
    openSignup: vars.TWO80_OPEN_SIGNUP === '1',
    minCliVersion: vars.TWO80_MIN_CLI_VERSION ?? '',
    sessionTtlDays: num(vars.TWO80_SESSION_TTL_DAYS, 30),
    loginRate: {
      windowSecs: num(vars.TWO80_LOGIN_RATE_WINDOW_SECS, 600),
      max: num(vars.TWO80_LOGIN_RATE_MAX, 30),
    },
    google: { clientId: vars.GOOGLE_CLIENT_ID ?? '', clientSecret: vars.GOOGLE_CLIENT_SECRET ?? '' },
    builder: selectBuilder(vars),
    build: { host: vars.TWO80_BUILD_HOST ?? '', token: vars.TWO80_BUILD_TOKEN ?? '' },
    depot: { token: vars.DEPOT_TOKEN ?? '', projectId: vars.DEPOT_PROJECT_ID ?? '' },
    cloudflare: { accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? '', apiToken: vars.CLOUDFLARE_API_TOKEN ?? '' },
    workerEntry: str(vars.TWO80_WORKER_ENTRY, 'worker.js'),
  };
}

// selectBuilder resolves the build home. An explicit TWO80_BUILDER wins; otherwise
// Depot is chosen only when its token is present, so a host with no Depot env (the
// live Railway service today) keeps the http builder unchanged.
function selectBuilder(vars: ConfigVars): 'http' | 'depot' {
  const explicit = vars.TWO80_BUILDER ?? '';
  if (explicit === 'depot') return 'depot';
  if (explicit === 'http') return 'http';
  return (vars.DEPOT_TOKEN ?? '') !== '' ? 'depot' : 'http';
}

// readConfig resolves the Worker's Env: the pg client dials the pooled Hyperdrive
// endpoint, not the raw Neon origin.
export function readConfig(env: Env): Config {
  return resolveConfig(env, env.HYPERDRIVE.connectionString);
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
  // The zone app URLs live on, and the gateway origin the share dialog's "view as"
  // links point at (the gateway owns view-as; the control plane only links to it).
  appDomain: string;
  viewAsOrigin: string;
  // Releases the request's pg client after the response, via ctx.waitUntil. Absent
  // for in-memory test wiring, whose shared store is closed once at teardown.
  close?: () => Promise<void>;
}
