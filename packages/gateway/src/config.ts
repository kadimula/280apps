import { PLATFORM_POLICY, resolvePlatformTopology } from '@280/contracts/platform-config';

export interface Env {
  HYPERDRIVE: Hyperdrive;

  DEPLOYMENT_ENVIRONMENT?: string;
  PLATFORM_DOMAIN?: string;
  APP_SERVING_DOMAIN?: string;

  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  MICROSOFT_ENTRA_OIDC_CLIENT_ID?: string;
  MICROSOFT_ENTRA_OIDC_CLIENT_SECRET?: string;
  IDENTITY_SIGNING_PRIVATE_JWK?: string;
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
  const topology = resolvePlatformTopology({
    environment: env.DEPLOYMENT_ENVIRONMENT,
    platformDomain: env.PLATFORM_DOMAIN,
    appServingDomain: env.APP_SERVING_DOMAIN,
  });

  return {
    dbSchema: PLATFORM_POLICY.databaseSchema,
    dbConnectionString: env.HYPERDRIVE.connectionString,
    appDomain: topology.appServingDomain,
    hostSuffix: topology.hostSuffix,
    authHost: topology.authHost,
    authOrigin: topology.authOrigin,
    cookieDomain: topology.gatewayCookieDomain,
    sessionTtlSecs: PLATFORM_POLICY.sessionTtlDays * 24 * 60 * 60,
    loginRate: {
      windowSecs: PLATFORM_POLICY.loginRateWindowSecs,
      max: PLATFORM_POLICY.loginRateMaxRequests,
    },
    idIssuer: topology.authOrigin,
    idTtlSecs: PLATFORM_POLICY.identityTokenTtlSecs,
    idSigningKid: PLATFORM_POLICY.identitySigningKid,
    idSigningJwk: env.IDENTITY_SIGNING_PRIVATE_JWK ?? '',
    entraTenant: PLATFORM_POLICY.entraTenant,
    fallbackRedirect: topology.dashboardOrigin,
    google: {
      clientId: env.GOOGLE_OIDC_CLIENT_ID ?? '',
      clientSecret: env.GOOGLE_OIDC_CLIENT_SECRET ?? '',
    },
    entra: {
      clientId: env.MICROSOFT_ENTRA_OIDC_CLIENT_ID ?? '',
      clientSecret: env.MICROSOFT_ENTRA_OIDC_CLIENT_SECRET ?? '',
    },
  };
}
