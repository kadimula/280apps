// Env -> Config for the gateway Worker. Mirrors packages/backend/src/config.ts.

export interface Env {
  // Shares the control plane's Postgres (users/sessions/oauth) via Hyperdrive.
  HYPERDRIVE: Hyperdrive;

  DATABASE_SCHEMA?: string;
  APP_BASE_DOMAIN?: string;
  APP_HOST_SUFFIX?: string;
  AUTH_HOST?: string;
  SESSION_COOKIE_DOMAIN?: string;
  SESSION_TTL_DAYS?: string;
  LOGIN_RATE_LIMIT_WINDOW_SECONDS?: string;
  LOGIN_RATE_LIMIT_MAX_REQUESTS?: string;
  IDENTITY_TOKEN_ISSUER?: string;
  IDENTITY_TOKEN_TTL_SECONDS?: string;
  IDENTITY_TOKEN_SIGNING_KID?: string;
  ENTRA_TENANT?: string;
  FALLBACK_REDIRECT_URL?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ENTRA_CLIENT_ID?: string;
  ENTRA_CLIENT_SECRET?: string;
  // ECDSA P-256 private key as a JWK JSON string. Only this Worker holds it.
  ID_SIGNING_JWK?: string;
}

export interface Config {
  dbSchema: string;
  dbConnectionString: string;
  appDomain: string;
  hostSuffix: string;
  authHost: string;
  authOrigin: string;
  cookieDomain: string;
  sessionTtlSecs: number;
  loginRate: { windowSecs: number; max: number };
  idIssuer: string;
  idTtlSecs: number;
  idSigningKid: string;
  idSigningJwk: string;
  entraTenant: string;
  fallbackRedirect: string;
  google: { clientId: string; clientSecret: string };
  entra: { clientId: string; clientSecret: string };
}

export function readConfig(env: Env): Config {
  const str = (v: string | undefined, fallback: string): string =>
    v !== undefined && v !== '' ? v : fallback;
  const num = (v: string | undefined, fallback: number): number => Number(str(v, String(fallback))) || fallback;

  const appDomain = str(env.APP_BASE_DOMAIN, '280apps.run');
  const authHost = str(env.AUTH_HOST, `auth.${appDomain}`);

  return {
    dbSchema: str(env.DATABASE_SCHEMA, 'platform'),
    dbConnectionString: env.HYPERDRIVE.connectionString,
    appDomain,
    hostSuffix: env.APP_HOST_SUFFIX ?? '',
    authHost,
    authOrigin: `https://${authHost}`,
    cookieDomain: str(env.SESSION_COOKIE_DOMAIN, `.${appDomain}`),
    sessionTtlSecs: num(env.SESSION_TTL_DAYS, 30) * 24 * 60 * 60,
    loginRate: {
      windowSecs: num(env.LOGIN_RATE_LIMIT_WINDOW_SECONDS, 600),
      max: num(env.LOGIN_RATE_LIMIT_MAX_REQUESTS, 30),
    },
    idIssuer: str(env.IDENTITY_TOKEN_ISSUER, `https://${authHost}`),
    idTtlSecs: num(env.IDENTITY_TOKEN_TTL_SECONDS, 120),
    idSigningKid: str(env.IDENTITY_TOKEN_SIGNING_KID, 'k1'),
    idSigningJwk: env.ID_SIGNING_JWK ?? '',
    entraTenant: str(env.ENTRA_TENANT, 'organizations'),
    fallbackRedirect: str(env.FALLBACK_REDIRECT_URL, 'https://280apps.com'),
    google: { clientId: env.GOOGLE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_CLIENT_SECRET ?? '' },
    entra: { clientId: env.ENTRA_CLIENT_ID ?? '', clientSecret: env.ENTRA_CLIENT_SECRET ?? '' },
  };
}
