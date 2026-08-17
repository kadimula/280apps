import { PLATFORM_POLICY, resolvePlatformTopology } from '@280/contracts/platform-config';
import type { Platform } from './deploysvc.js';
import type { Auth } from './authsvc.js';
import type { SecretCipher } from './secrets.js';
import type { IntegrationService } from './integrations/service.js';

export interface ConfigVars {
  RAILWAY_ENVIRONMENT_NAME?: string;
  PLATFORM_DOMAIN?: string;
  APP_SERVING_DOMAIN?: string;
  ADDITIONAL_FRAME_ANCESTORS?: string;
  MINIMUM_SUPPORTED_CLI_VERSION?: string;
  DEPOT_BUILD_PROJECT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;

  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  GOOGLE_INTEGRATION_CLIENT_ID?: string;
  GOOGLE_INTEGRATION_CLIENT_SECRET?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_PROJECT_NUMBER?: string;
  DEPOT_API_TOKEN?: string;
  CLOUDFLARE_DEPLOY_API_TOKEN?: string;
  DATABASE_URL?: string;
  APP_SECRET_LOCAL_MASTER_KEY?: string;
  APP_SECRET_LOCAL_KEY_ID?: string;
  APP_SECRET_KMS_KEY_NAME?: string;
  APP_SECRET_KMS_CREDENTIALS_JSON?: string;
}

export interface Config {
  dbSchema: string;
  dbConnectionString: string;
  appDomain: string;
  hostSuffix: string;
  apiOrigin: string;
  dashboardOrigin: string;
  frameAncestors: string;
  activationUrl: string;
  cookieDomain: string;
  sessionCookieName: string;
  oauthCookieName: string;
  minCliVersion: string;
  sessionTtlDays: number;
  machineTokenTtlDays: number;
  loginRate: { windowSecs: number; max: number };
  google: { clientId: string; clientSecret: string };
  // A dedicated OAuth client for third-party data integrations, separate from the
  // dashboard login client above so their consent scopes never mix.
  googleIntegration: { clientId: string; clientSecret: string; pickerApiKey: string; projectNumber: string };
  depot: { token: string; projectId: string };
  cloudflare: { accountId: string; apiToken: string };
  workerEntry: string;
  gatewayService: string;
  idIssuer: string;
  authOrigin: string;
  secretEncryption: { localKey: string; localKeyId: string; kmsKeyName: string; kmsCredentialsJson: string };
}

export function resolveConfig(vars: ConfigVars, dbConnectionString: string): Config {
  const topology = resolvePlatformTopology({
    environment: vars.RAILWAY_ENVIRONMENT_NAME,
    platformDomain: vars.PLATFORM_DOMAIN,
    appServingDomain: vars.APP_SERVING_DOMAIN,
  });
  const additionalFrameAncestors = vars.ADDITIONAL_FRAME_ANCESTORS?.trim() ?? '';

  return {
    dbSchema: PLATFORM_POLICY.databaseSchema,
    dbConnectionString,
    appDomain: topology.appServingDomain,
    hostSuffix: topology.hostSuffix,
    apiOrigin: topology.apiOrigin,
    dashboardOrigin: topology.dashboardOrigin,
    frameAncestors: [topology.dashboardOrigin, additionalFrameAncestors].filter(Boolean).join(' '),
    activationUrl: topology.activationUrl,
    cookieDomain: topology.backendCookieDomain,
    sessionCookieName: topology.sessionCookieName,
    oauthCookieName: topology.oauthCookieName,
    minCliVersion: vars.MINIMUM_SUPPORTED_CLI_VERSION ?? '',
    sessionTtlDays: PLATFORM_POLICY.sessionTtlDays,
    machineTokenTtlDays: PLATFORM_POLICY.machineTokenTtlDays,
    loginRate: {
      windowSecs: PLATFORM_POLICY.loginRateWindowSecs,
      max: PLATFORM_POLICY.loginRateMaxRequests,
    },
    google: {
      clientId: vars.GOOGLE_OIDC_CLIENT_ID ?? '',
      clientSecret: vars.GOOGLE_OIDC_CLIENT_SECRET ?? '',
    },
    googleIntegration: {
      clientId: vars.GOOGLE_INTEGRATION_CLIENT_ID ?? '',
      clientSecret: vars.GOOGLE_INTEGRATION_CLIENT_SECRET ?? '',
      pickerApiKey: vars.GOOGLE_PICKER_API_KEY ?? '',
      projectNumber: vars.GOOGLE_PROJECT_NUMBER ?? '',
    },
    depot: { token: vars.DEPOT_API_TOKEN ?? '', projectId: vars.DEPOT_BUILD_PROJECT_ID ?? '' },
    cloudflare: {
      accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? '',
      apiToken: vars.CLOUDFLARE_DEPLOY_API_TOKEN ?? '',
    },
    workerEntry: PLATFORM_POLICY.workerEntrypoint,
    gatewayService: topology.gatewayService,
    idIssuer: topology.authOrigin,
    authOrigin: topology.authOrigin,
    secretEncryption: {
      localKey: vars.APP_SECRET_LOCAL_MASTER_KEY ?? '',
      localKeyId: vars.APP_SECRET_LOCAL_KEY_ID ?? '',
      kmsKeyName: vars.APP_SECRET_KMS_KEY_NAME ?? '',
      kmsCredentialsJson: vars.APP_SECRET_KMS_CREDENTIALS_JSON ?? '',
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
  integrations?: IntegrationService;
}
