import { DeployCode, type DeployError } from '@280/contracts';
import { resolvePlatformTopology } from '@280/contracts/platform-config';
import { Auth } from './authsvc.js';
import { GoogleProvider, type OidcProvider } from './auth/oidc.js';
import { IntegrationService } from './integrations/service.js';
import { ProviderRegistry } from './integrations/registry.js';
import { GoogleWorkspaceProvider } from './integrations/google/provider.js';
import { SdkIdentityVerifier } from './integrations/sdk-identity.js';
import { DepotBuilder } from './runtime/container/depot-builder.js';
import type { ContainerBuilder } from './runtime/container/container.js';
import type { ConfigDelivery, ExpiryCounts, Store } from './seams.js';
import type { Logger } from './observe.js';
import type { Config } from './config.js';
import type { SecretCipher } from './secrets.js';
import { ControlPlaneConfigDelivery } from './config-delivery.js';
import { missingRequirements } from './deploysvc.js';

export interface ContainerServices {
  builder: ContainerBuilder;
  configDelivery: ConfigDelivery;
}

export function buildContainerServices(
  config: Config,
  log: Logger,
  store: Store,
  cipher?: SecretCipher,
): ContainerServices {
  const builder = buildDepotBuilder(config, log);
  return {
    builder,
    configDelivery: new ControlPlaneConfigDelivery(store, cipher),
  };
}

function buildDepotBuilder(config: Config, log: Logger): DepotBuilder {
  const missing = [
    ['DEPOT_API_TOKEN', config.depot.token],
    ['CLOUDFLARE_ACCOUNT_ID', config.cloudflare.accountId],
    ['CLOUDFLARE_DEPLOY_API_TOKEN', config.cloudflare.apiToken],
  ].filter(([, v]) => v === '').map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`the depot builder requires ${missing.join(', ')}`);
  }
  if (config.depot.projectId === '') {
    log.warn('DEPOT_BUILD_PROJECT_ID unset: a project is resolved per app via the Depot API');
  }
  return new DepotBuilder({
    accountId: config.cloudflare.accountId,
    apiToken: config.cloudflare.apiToken,
    depotToken: config.depot.token,
    projectId: config.depot.projectId || undefined,
    workerEntry: config.workerEntry,
    appDomain: config.appDomain,
    hostSuffix: config.hostSuffix,
    gatewayService: config.gatewayService,
    idIssuer: config.idIssuer,
    sdkApiOrigin: config.apiOrigin,
    frameAncestors: config.frameAncestors,
    log,
  });
}

// buildAuth wires the browser-login flow, or returns undefined when no provider is
// configured. Undefined is not fatal (the deploy API still serves), but the web
// surface is inert without it, so it is called out.
export function buildAuth(store: Store, config: Config, log: Logger): Auth | undefined {
  const providers: Record<string, OidcProvider> = {};
  if (config.google.clientId !== '' && config.google.clientSecret !== '') {
    providers.google = new GoogleProvider({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
    });
  }

  if (Object.keys(providers).length === 0) {
    log.warn(
      'no login provider configured (set GOOGLE_OIDC_CLIENT_ID/GOOGLE_OIDC_CLIENT_SECRET): the web surface cannot sign anyone in',
    );
    return undefined;
  }

  return new Auth(store, {
    providers,
    apiOrigin: config.apiOrigin,
    frontendOrigin: config.dashboardOrigin,
    cookieDomain: config.cookieDomain,
    sessionCookieName: config.sessionCookieName,
    oauthCookieName: config.oauthCookieName,
    sessionTtlSecs: config.sessionTtlDays * 24 * 60 * 60,
    rate: { windowSecs: config.loginRate.windowSecs, max: config.loginRate.max },
  });
}

// buildIntegrations wires the third-party integration core, or returns undefined when
// it cannot run: no dedicated Google integration client, or no secret encryption key
// to protect credentials. Undefined leaves the integration surface inert (404), never
// fatal, matching buildAuth. The SDK boundary verifies identity against the gateway's
// published JWKS, derived from the identity issuer origin.
export function buildIntegrations(
  store: Store,
  config: Config,
  log: Logger,
  cipher?: SecretCipher,
): IntegrationService | undefined {
  const g = config.googleIntegration;
  if (g.clientId === '' || g.clientSecret === '') {
    log.warn('integrations disabled: set GOOGLE_INTEGRATION_CLIENT_ID/GOOGLE_INTEGRATION_CLIENT_SECRET to enable them');
    return undefined;
  }
  if (cipher === undefined) {
    log.warn('integrations disabled: credential encryption requires APP_SECRETS_KMS_* or APP_SECRETS_LOCAL_MASTER_KEY');
    return undefined;
  }
  const registry = new ProviderRegistry([
    new GoogleWorkspaceProvider({ clientId: g.clientId, clientSecret: g.clientSecret }),
  ]);
  const identity = new SdkIdentityVerifier({
    jwksUri: `${config.idIssuer.replace(/\/$/, '')}/.well-known/280-identity.jwks`,
    issuer: config.idIssuer,
  });
  return new IntegrationService({
    store,
    cipher,
    registry,
    identity,
    config: {
      apiOrigin: config.apiOrigin,
      frontendOrigin: config.dashboardOrigin,
      picker: { apiKey: g.pickerApiKey, projectNumber: g.projectNumber },
    },
  });
}

// sweepExpired is the scheduled cleanup's core, factored out of the Worker so it is
// testable against any Store: delete expired sessions, device codes, lapsed
// login-rate windows, and machine tokens past their ttl, and log the counts.
export const WAITING_SECRETS_TTL_SECS = 30 * 60;

export async function sweepExpired(
  store: Store,
  log: Logger,
  now: number,
  machineTokenTtlSecs: number,
  frontendOrigin = resolvePlatformTopology({}).dashboardOrigin,
): Promise<ExpiryCounts> {
  const counts = await store.deleteExpired(now, machineTokenTtlSecs);
  const waiting = await store.waitingDeploysBefore(now - WAITING_SECRETS_TTL_SECS);
  let waitingSecrets = 0;
  for (const dep of waiting) {
    // Point the deep link at whatever the deploy is actually blocked on: a missing
    // secret/config value (?variables=1) or an unbound integration alias
    // (?integrations=1). Secrets take precedence when both are outstanding.
    const missing = await missingRequirements(store, dep.appId, dep.manifest);
    const onSecrets = missing.secrets.length > 0 || missing.integrations.length === 0;
    const tab = onSecrets ? 'variables' : 'integrations';
    const waitingFor = onSecrets ? 'app secrets' : 'integration connections';
    const link = `${frontendOrigin.replace(/\/$/, '')}/dashboard/${encodeURIComponent(dep.appId)}?${tab}=1`;
    const failure: DeployError = {
      code: DeployCode.Unavailable,
      message: `deployment expired while waiting for ${waitingFor}`,
      fix: `set them at ${link}, then run two80 push again`,
      retryable: false,
      candidates: [],
    };
    if (await store.failWaitingSecrets(dep.appId, dep.id, failure)) waitingSecrets++;
  }
  log.info('scheduled cleanup', {
    sessions: counts.sessions,
    deviceCodes: counts.deviceCodes,
    rateLimits: counts.rateLimits,
    tokens: counts.tokens,
    previewGrants: counts.previewGrants,
    integrationAttempts: counts.integrationAttempts,
    waitingSecrets,
  });
  return counts;
}
