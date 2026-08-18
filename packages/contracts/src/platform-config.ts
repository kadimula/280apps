export const PLATFORM_POLICY = {
  databaseSchema: 'platform',
  // Test/dev fallback only. The live roll must use the absolute vendored path from
  // APP_WORKER_ENTRYPOINT (config.ts); this bare basename does not resolve in the roll temp dir.
  workerEntrypoint: 'worker.js',
  sessionTtlDays: 30,
  machineTokenTtlDays: 90,
  loginRateWindowSecs: 600,
  loginRateMaxRequests: 30,
  sweepIntervalSecs: 60,
  identityTokenTtlSecs: 30,
  identitySigningKid: 'k2',
  entraTenant: 'organizations',
} as const;

export interface PlatformTopologyInput {
  environment?: string;
  platformDomain?: string;
  appServingDomain?: string;
}

export interface PlatformTopology {
  environment: string;
  platformDomain: string;
  appServingDomain: string;
  hostSuffix: string;
  dashboardOrigin: string;
  apiOrigin: string;
  activationUrl: string;
  backendCookieDomain: string;
  gatewayCookieDomain: string;
  sessionCookieName: string;
  oauthCookieName: string;
  authHost: string;
  authOrigin: string;
  gatewayService: string;
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENVIRONMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function resolvePlatformTopology(input: PlatformTopologyInput): PlatformTopology {
  const environment = input.environment?.trim().toLowerCase() || 'production';
  const platformDomain = domain(input.platformDomain, '280apps.com', 'PLATFORM_DOMAIN');
  const appServingDomain = domain(input.appServingDomain, '280apps.run', 'APP_SERVING_DOMAIN');
  if (!ENVIRONMENT.test(environment)) throw new Error('deployment environment must be a DNS label');

  const hostSuffix = environment === 'production' ? '' : `-${environment}`;
  const cookieSuffix = environment === 'production' ? '' : `_${environment.replaceAll('-', '_')}`;
  const dashboardHost = environment === 'production' ? platformDomain : `${environment}.${platformDomain}`;
  const dashboardOrigin = `https://${dashboardHost}`;
  const authHost = `auth${hostSuffix}.${appServingDomain}`;

  return {
    environment,
    platformDomain,
    appServingDomain,
    hostSuffix,
    dashboardOrigin,
    apiOrigin: `https://api${hostSuffix}.${platformDomain}`,
    activationUrl: `${dashboardOrigin}/activate`,
    backendCookieDomain: `.${platformDomain}`,
    gatewayCookieDomain: `.${appServingDomain}`,
    sessionCookieName: `280_session${cookieSuffix}`,
    oauthCookieName: `280_oauth${cookieSuffix}`,
    authHost,
    authOrigin: `https://${authHost}`,
    gatewayService: `280-gateway${hostSuffix}`,
  };
}

function domain(value: string | undefined, fallback: string, name: string): string {
  const result = (value?.trim() || fallback).toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!DOMAIN.test(result)) throw new Error(`${name} must be a DNS domain without a scheme or path`);
  return result;
}
