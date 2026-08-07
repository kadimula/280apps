// Dependency construction shared by the host entrypoints: runtime selection,
// auth wiring, and the scheduled-sweep core.

import { DeployCode, type DeployError } from '@280/contracts';
import { Auth } from './authsvc.js';
import { GoogleProvider, type OidcProvider } from './auth/oidc.js';
import { MemoryRuntime, container } from './runtime/index.js';
import { DepotBuilder } from './runtime/container/depot-builder.js';
import type { ExpiryCounts, Runtime, SecretDelivery, Store } from './seams.js';
import type { Logger } from './observe.js';
import type { Config } from './config.js';
import type { SecretCipher } from './secrets.js';
import { ControlPlaneSecretDelivery } from './secret-delivery.js';

// selectRuntime picks where apps run and which build home compiles their images.
// Misconfiguration is a request failure rather than a degraded mode: a platform
// that accepts pushes and hosts nothing is the one outcome with no honest error
// message for the agent. Depot is the sole build home; nothing above this seam
// changes if another is ever added.
export interface RuntimeSelection {
  runtime: Runtime;
  secretDelivery?: SecretDelivery;
}

export function selectRuntime(
  config: Config,
  log: Logger,
  store: Store,
  cipher?: SecretCipher,
): RuntimeSelection {
  if (config.runtime === 'memory') {
    log.warn('runtime=memory: deploys will be recorded but nothing will be hosted');
    return { runtime: new MemoryRuntime() };
  }
  const builder = buildDepotBuilder(config, log);
  const secretDelivery = new ControlPlaneSecretDelivery(store, cipher, builder);
  return { runtime: new container.ContainerRuntime(builder, secretDelivery), secretDelivery };
}

function buildDepotBuilder(config: Config, log: Logger): DepotBuilder {
  const missing = [
    ['DEPOT_TOKEN', config.depot.token],
    ['CLOUDFLARE_ACCOUNT_ID', config.cloudflare.accountId],
    ['CLOUDFLARE_API_TOKEN', config.cloudflare.apiToken],
  ].filter(([, v]) => v === '').map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`the depot builder requires ${missing.join(', ')} (or set TWO80_RUNTIME=memory)`);
  }
  if (config.depot.projectId === '') {
    log.warn('DEPOT_PROJECT_ID unset: a project is resolved per app via the Depot API');
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
      'no login provider configured (set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET): the web surface cannot sign anyone in',
    );
    return undefined;
  }

  return new Auth(store, {
    providers,
    apiOrigin: config.apiOrigin,
    frontendOrigin: config.frontendOrigin,
    cookieDomain: config.cookieDomain,
    sessionCookieName: config.sessionCookieName,
    oauthCookieName: config.oauthCookieName,
    sessionTtlSecs: config.sessionTtlDays * 24 * 60 * 60,
    rate: { windowSecs: config.loginRate.windowSecs, max: config.loginRate.max },
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
  frontendOrigin = 'https://console.280apps.com',
): Promise<ExpiryCounts> {
  const counts = await store.deleteExpired(now, machineTokenTtlSecs);
  const waiting = await store.waitingDeploysBefore(now - WAITING_SECRETS_TTL_SECS);
  let waitingSecrets = 0;
  for (const dep of waiting) {
    const link = `${frontendOrigin.replace(/\/$/, '')}/dashboard/${encodeURIComponent(dep.appId)}?variables=1`;
    const failure: DeployError = {
      code: DeployCode.Unavailable,
      message: 'deployment expired while waiting for app secrets',
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
    waitingSecrets,
  });
  return counts;
}
