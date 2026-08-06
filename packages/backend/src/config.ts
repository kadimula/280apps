// Config and secrets: the raw string vars the host reads off process.env, and
// resolveConfig(), the one place they turn into typed values.

import type { Platform } from './deploysvc.js';
import type { Auth } from './authsvc.js';
import type { SecretCipher } from './secrets.js';

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
  // TWO80_FRAME_ANCESTORS is the space-separated origin allowlist baked into each
  // app Worker as the CSP frame-ancestors (who may embed an app host). Default is
  // the frontend origin, so the dashboard can always preview its own apps.
  TWO80_FRAME_ANCESTORS?: string;
  TWO80_VERIFICATION_URI?: string;
  TWO80_COOKIE_DOMAIN?: string;
  TWO80_MIN_CLI_VERSION?: string;
  TWO80_SESSION_TTL_DAYS?: string;
  TWO80_MACHINE_TOKEN_TTL_DAYS?: string;
  TWO80_LOGIN_RATE_WINDOW_SECS?: string;
  TWO80_LOGIN_RATE_MAX?: string;
  // DEPOT_PROJECT_ID pins every Depot build to one project (isolated layer cache).
  // Unset resolves a project per app via the Depot API.
  DEPOT_PROJECT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  // TWO80_WORKER_ENTRY is the App280Container harness Worker the generated roll
  // config points `main` at; supplied by the runtime image, not the app source.
  TWO80_WORKER_ENTRY?: string;
  // TWO80_GATEWAY_SERVICE is the central identity gateway Worker the per-app roll
  // binds (GATEWAY service binding). Default 280-gateway<hostSuffix>.
  TWO80_GATEWAY_SERVICE?: string;
  // TWO80_ID_ISSUER is the identity-token issuer the per-app middleware verifies
  // against; it must match what the gateway signs. Default https://auth<suffix>.<domain>.
  TWO80_ID_ISSUER?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DEPOT_TOKEN?: string;
  // CLOUDFLARE_API_TOKEN pushes the built image to registry.cloudflare.com and
  // authorizes the wrangler roll. Required for the depot builder.
  CLOUDFLARE_API_TOKEN?: string;
  DATABASE_URL?: string;
  TWO80_SECRET_ENCRYPTION_KEY?: string;
  TWO80_SECRET_ENCRYPTION_KEY_ID?: string;
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
  frameAncestors: string;
  verificationUri: string;
  cookieDomain: string;
  minCliVersion: string;
  sessionTtlDays: number;
  // A CLI machine token is valid only while its created_at is within this window;
  // a change applies retroactively, so shortening it revokes older tokens at once.
  machineTokenTtlDays: number;
  loginRate: { windowSecs: number; max: number };
  google: { clientId: string; clientSecret: string };
  // depot is the managed remote BuildKit build home, the sole build path.
  depot: { token: string; projectId: string };
  // cloudflare authenticates the registry push and the wrangler roll (depot builder).
  cloudflare: { accountId: string; apiToken: string };
  // workerEntry is the App280Container harness Worker the roll config references.
  workerEntry: string;
  // The per-app serving topology the roll bakes in: the central gateway service the
  // GATEWAY binding targets and the identity issuer the middleware verifies.
  gatewayService: string;
  idIssuer: string;
  secretEncryption: { key: string; keyId: string };
}

// resolveConfig turns raw vars into typed Config. dbConnectionString is injected
// separately because it is the one value not read straight off vars.
export function resolveConfig(vars: ConfigVars, dbConnectionString: string): Config {
  const str = (v: string | undefined, fallback: string): string =>
    v !== undefined && v !== '' ? v : fallback;
  const num = (v: string | undefined, fallback: number): number => Number(str(v, String(fallback))) || fallback;

  const appDomain = str(vars.TWO80_APP_DOMAIN, '280apps.run');
  const hostSuffix = vars.TWO80_APP_HOST_SUFFIX ?? '';
  const frontendOrigin = str(vars.TWO80_FRONTEND_ORIGIN, 'https://console.280apps.com');

  return {
    runtime: str(vars.TWO80_RUNTIME, 'container') === 'memory' ? 'memory' : 'container',
    logFormat: str(vars.TWO80_LOG_FORMAT, 'text') === 'json' ? 'json' : 'text',
    dbSchema: str(vars.TWO80_DB_SCHEMA, 'platform'),
    dbConnectionString,
    appDomain,
    hostSuffix,
    apiOrigin: str(vars.TWO80_API_ORIGIN, 'https://api.280apps.com'),
    frontendOrigin,
    frameAncestors: str(vars.TWO80_FRAME_ANCESTORS, frontendOrigin),
    verificationUri: str(vars.TWO80_VERIFICATION_URI, 'https://280apps.com/activate'),
    cookieDomain: vars.TWO80_COOKIE_DOMAIN ?? '',
    minCliVersion: vars.TWO80_MIN_CLI_VERSION ?? '',
    sessionTtlDays: num(vars.TWO80_SESSION_TTL_DAYS, 30),
    machineTokenTtlDays: num(vars.TWO80_MACHINE_TOKEN_TTL_DAYS, 90),
    loginRate: {
      windowSecs: num(vars.TWO80_LOGIN_RATE_WINDOW_SECS, 600),
      max: num(vars.TWO80_LOGIN_RATE_MAX, 30),
    },
    google: { clientId: vars.GOOGLE_CLIENT_ID ?? '', clientSecret: vars.GOOGLE_CLIENT_SECRET ?? '' },
    depot: { token: vars.DEPOT_TOKEN ?? '', projectId: vars.DEPOT_PROJECT_ID ?? '' },
    cloudflare: { accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? '', apiToken: vars.CLOUDFLARE_API_TOKEN ?? '' },
    workerEntry: str(vars.TWO80_WORKER_ENTRY, 'worker.js'),
    gatewayService: str(vars.TWO80_GATEWAY_SERVICE, `280-gateway${hostSuffix}`),
    idIssuer: str(vars.TWO80_ID_ISSUER, `https://auth${hostSuffix}.${appDomain}`),
    secretEncryption: {
      key: vars.TWO80_SECRET_ENCRYPTION_KEY ?? '',
      keyId: vars.TWO80_SECRET_ENCRYPTION_KEY_ID ?? '',
    },
  };
}

// RequestDeps is the I/O container the deps middleware puts on the context.
export interface RequestDeps {
  platform: Platform;
  // Unset when no login provider is configured (a memory-runtime dev loop): the web
  // surface fails closed, the deploy API still serves.
  auth?: Auth;
  verificationUri: string;
  minCliVersion: string;
  // now - this is the created_at cutoff authorize() passes to userByToken: a token
  // created before it is expired and answers exactly like an unknown one.
  machineTokenTtlSecs: number;
  // The zone app URLs live on, and the gateway origin the share dialog's "view as"
  // links point at (the gateway owns view-as; the control plane only links to it).
  appDomain: string;
  viewAsOrigin: string;
  secretCipher?: SecretCipher;
}
