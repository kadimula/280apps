import type { Platform } from './deploysvc.js';
import type { Auth } from './authsvc.js';
import type { SecretCipher } from './secrets.js';

export interface ConfigVars {
  LOG_FORMAT?: string;
  DATABASE_SCHEMA?: string;
  APP_BASE_DOMAIN?: string;
  APP_HOST_SUFFIX?: string;
  BACKEND_API_ORIGIN?: string;
  FRONTEND_ORIGIN?: string;
  APP_FRAME_ANCESTORS?: string;
  DEVICE_APPROVAL_URL?: string;
  SESSION_COOKIE_DOMAIN?: string;
  SESSION_COOKIE_NAME?: string;
  OAUTH_COOKIE_NAME?: string;
  MINIMUM_CLI_VERSION?: string;
  SESSION_TTL_DAYS?: string;
  MACHINE_TOKEN_TTL_DAYS?: string;
  LOGIN_RATE_LIMIT_WINDOW_SECONDS?: string;
  LOGIN_RATE_LIMIT_MAX_REQUESTS?: string;
  DEPOT_PROJECT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  APP_WORKER_ENTRYPOINT?: string;
  IDENTITY_GATEWAY_SERVICE?: string;
  IDENTITY_TOKEN_ISSUER?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DEPOT_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  DATABASE_URL?: string;
  APP_SECRETS_LOCAL_MASTER_KEY?: string;
  APP_SECRETS_LOCAL_KEY_ID?: string;
  APP_SECRETS_KMS_KEY_NAME?: string;
  APP_SECRETS_KMS_CREDENTIALS_JSON?: string;
}

export interface Config {
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
  sessionCookieName: string;
  oauthCookieName: string;
  minCliVersion: string;
  sessionTtlDays: number;
  machineTokenTtlDays: number;
  loginRate: { windowSecs: number; max: number };
  google: { clientId: string; clientSecret: string };
  depot: { token: string; projectId: string };
  cloudflare: { accountId: string; apiToken: string };
  workerEntry: string;
  gatewayService: string;
  idIssuer: string;
  secretEncryption: { localKey: string; localKeyId: string; kmsKeyName: string; kmsCredentialsJson: string };
}

export function resolveConfig(vars: ConfigVars, dbConnectionString: string): Config {
  const str = (v: string | undefined, fallback: string): string =>
    v !== undefined && v !== '' ? v : fallback;
  const num = (v: string | undefined, fallback: number): number => Number(str(v, String(fallback))) || fallback;

  const appDomain = str(vars.APP_BASE_DOMAIN, '280apps.run');
  const hostSuffix = vars.APP_HOST_SUFFIX ?? '';
  const frontendOrigin = str(vars.FRONTEND_ORIGIN, 'https://console.280apps.com');

  return {
    logFormat: str(vars.LOG_FORMAT, 'text') === 'json' ? 'json' : 'text',
    dbSchema: str(vars.DATABASE_SCHEMA, 'platform'),
    dbConnectionString,
    appDomain,
    hostSuffix,
    apiOrigin: str(vars.BACKEND_API_ORIGIN, 'https://api.280apps.com'),
    frontendOrigin,
    frameAncestors: str(vars.APP_FRAME_ANCESTORS, frontendOrigin),
    verificationUri: str(vars.DEVICE_APPROVAL_URL, 'https://280apps.com/activate'),
    cookieDomain: vars.SESSION_COOKIE_DOMAIN ?? '',
    sessionCookieName: str(vars.SESSION_COOKIE_NAME, '280_session'),
    oauthCookieName: str(vars.OAUTH_COOKIE_NAME, '280_oauth'),
    minCliVersion: vars.MINIMUM_CLI_VERSION ?? '',
    sessionTtlDays: num(vars.SESSION_TTL_DAYS, 30),
    machineTokenTtlDays: num(vars.MACHINE_TOKEN_TTL_DAYS, 90),
    loginRate: {
      windowSecs: num(vars.LOGIN_RATE_LIMIT_WINDOW_SECONDS, 600),
      max: num(vars.LOGIN_RATE_LIMIT_MAX_REQUESTS, 30),
    },
    google: { clientId: vars.GOOGLE_CLIENT_ID ?? '', clientSecret: vars.GOOGLE_CLIENT_SECRET ?? '' },
    depot: { token: vars.DEPOT_TOKEN ?? '', projectId: vars.DEPOT_PROJECT_ID ?? '' },
    cloudflare: { accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? '', apiToken: vars.CLOUDFLARE_API_TOKEN ?? '' },
    workerEntry: str(vars.APP_WORKER_ENTRYPOINT, 'worker.js'),
    gatewayService: str(vars.IDENTITY_GATEWAY_SERVICE, `280-gateway${hostSuffix}`),
    idIssuer: str(vars.IDENTITY_TOKEN_ISSUER, `https://auth${hostSuffix}.${appDomain}`),
    secretEncryption: {
      localKey: vars.APP_SECRETS_LOCAL_MASTER_KEY ?? '',
      localKeyId: vars.APP_SECRETS_LOCAL_KEY_ID ?? '',
      kmsKeyName: vars.APP_SECRETS_KMS_KEY_NAME ?? '',
      kmsCredentialsJson: vars.APP_SECRETS_KMS_CREDENTIALS_JSON ?? '',
    },
  };
}

export interface RequestDeps {
  platform: Platform;
  auth?: Auth;
  verificationUri: string;
  minCliVersion: string;
  machineTokenTtlSecs: number;
  appDomain: string;
  viewAsOrigin: string;
  secretCipher?: SecretCipher;
}
