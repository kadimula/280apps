// Env -> Config for the gateway Worker. Mirrors packages/backend/src/config.ts.

export interface Env {
  // Shares the control plane's Postgres (users/sessions/oauth) via Hyperdrive.
  HYPERDRIVE: Hyperdrive;

  TWO80_DB_SCHEMA?: string;
  TWO80_APP_DOMAIN?: string;
  TWO80_APP_HOST_SUFFIX?: string;
  TWO80_AUTH_HOST?: string;
  TWO80_COOKIE_DOMAIN?: string;
  TWO80_SESSION_TTL_DAYS?: string;
  TWO80_LOGIN_RATE_WINDOW_SECS?: string;
  TWO80_LOGIN_RATE_MAX?: string;
  TWO80_ID_ISSUER?: string;
  TWO80_ID_TTL_SECS?: string;
  TWO80_ID_SIGNING_KID?: string;
  TWO80_ENTRA_TENANT?: string;
  TWO80_FALLBACK_REDIRECT?: string;

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

  const appDomain = str(env.TWO80_APP_DOMAIN, '280apps.run');
  const authHost = str(env.TWO80_AUTH_HOST, `auth.${appDomain}`);

  return {
    dbSchema: str(env.TWO80_DB_SCHEMA, 'platform'),
    dbConnectionString: env.HYPERDRIVE.connectionString,
    appDomain,
    hostSuffix: env.TWO80_APP_HOST_SUFFIX ?? '',
    authHost,
    authOrigin: `https://${authHost}`,
    cookieDomain: str(env.TWO80_COOKIE_DOMAIN, `.${appDomain}`),
    sessionTtlSecs: num(env.TWO80_SESSION_TTL_DAYS, 30) * 24 * 60 * 60,
    loginRate: {
      windowSecs: num(env.TWO80_LOGIN_RATE_WINDOW_SECS, 600),
      max: num(env.TWO80_LOGIN_RATE_MAX, 30),
    },
    idIssuer: str(env.TWO80_ID_ISSUER, `https://${authHost}`),
    idTtlSecs: num(env.TWO80_ID_TTL_SECS, 120),
    idSigningKid: str(env.TWO80_ID_SIGNING_KID, 'k1'),
    idSigningJwk: env.ID_SIGNING_JWK ?? '',
    entraTenant: str(env.TWO80_ENTRA_TENANT, 'organizations'),
    fallbackRedirect: str(env.TWO80_FALLBACK_REDIRECT, 'https://280apps.com'),
    google: { clientId: env.GOOGLE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_CLIENT_SECRET ?? '' },
    entra: { clientId: env.ENTRA_CLIENT_ID ?? '', clientSecret: env.ENTRA_CLIENT_SECRET ?? '' },
  };
}
