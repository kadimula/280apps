// Config and secrets: the raw string vars the host reads off process.env, and
// resolveConfig(), the one place they turn into typed values.

import type { Platform } from './deploysvc.js';
import type { Auth } from './authsvc.js';

// ConfigVars is the raw environment the host reads: non-secret tunables and
// secrets, all optional strings (absent ⇒ undefined).
export interface ConfigVars {
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
  TWO80_BUILD_HOST?: string;
  // TWO80_BUILDER selects the build home: 'http' (the self-hosted Docker build
  // host, the default) or 'depot' (managed remote BuildKit). Unset falls back to
  // 'depot' only when DEPOT_TOKEN is present, else 'http' — so a host with no Depot
  // env keeps its current behavior.
  TWO80_BUILDER?: string;
  // DEPOT_PROJECT_ID pins every Depot build to one project (isolated layer cache).
  // Unset resolves a project per app via the Depot API.
  DEPOT_PROJECT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  // TWO80_WORKER_ENTRY is the App280Container harness Worker the generated roll
  // config points `main` at; supplied by the runtime image, not the app source.
  TWO80_WORKER_ENTRY?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TWO80_BUILD_TOKEN?: string;
  DEPOT_TOKEN?: string;
  // CLOUDFLARE_API_TOKEN pushes the built image to registry.cloudflare.com and
  // authorizes the wrangler roll. Required for the depot builder.
  CLOUDFLARE_API_TOKEN?: string;
  DATABASE_URL?: string;
}

// Config is ConfigVars resolved: defaults applied, numbers parsed, secrets grouped.
export interface Config {
  runtime: 'container' | 'memory';
  logFormat: 'json' | 'text';
  dbSchema: string;
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

// resolveConfig turns raw vars into typed Config. dbConnectionString is injected
// separately because it is the one value not read straight off vars.
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

// RequestDeps is the I/O container the deps middleware puts on the context.
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
}
