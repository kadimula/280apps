// Request-scoped dependency construction: the Worker's assembly point.
// buildRequestDeps turns one Env into the per-request I/O container the deps
// middleware puts on the context. Nothing here is an isolate singleton; per-app
// activation serialization lives in the AppActivator Durable Object.

import { Platform } from './deploysvc.js';
import { DurableObjectActivator } from './activator.js';
import { Auth } from './authsvc.js';
import { GoogleProvider, type OidcProvider } from './auth/oidc.js';
import { newPgStore } from './store/store.js';
import { R2BlobStore } from './blobstore/r2.js';
import { MemoryRuntime, container } from './runtime/index.js';
import { DepotBuilder } from './runtime/container/depot-builder.js';
import type { ExpiryCounts, Runtime, Store } from './seams.js';
import type { Logger } from './observe.js';
import { readConfig, type Config, type Env, type RequestDeps } from './config.js';

// buildRequestDeps constructs the request-scoped I/O container from Env, once per
// request. The pg client is lazy and closed after the response via close(). No
// runtime is built here: activation runs in the AppActivator Durable Object, which
// builds its own from the same Env; the request path only hands it a deploy.
export function buildRequestDeps(env: Env, log: Logger): RequestDeps {
  const config = readConfig(env);

  const store = newPgStore(config.dbConnectionString, config.dbSchema);
  const blobs = new R2BlobStore(env.BLOBS);
  const auth = buildAuth(store, config, log);

  const platform = new Platform({
    store,
    blobs,
    activator: new DurableObjectActivator(env.APP_ACTIVATOR),
    appDomain: config.appDomain,
    hostSuffix: config.hostSuffix,
  });

  return {
    platform,
    auth,
    openSignup: config.openSignup,
    verificationUri: config.verificationUri,
    minCliVersion: config.minCliVersion,
    appDomain: config.appDomain,
    viewAsOrigin: `https://auth.${config.appDomain}`,
    close: () => store.close(),
  };
}

// selectRuntime picks where apps run and which build home compiles their images.
// Misconfiguration is a request failure rather than a degraded mode: a platform
// that accepts pushes and hosts nothing is the one outcome with no honest error
// message for the agent. The builder is config-driven (config.builder) so a new
// build home is a new ContainerBuilder plus one branch here — nothing above this
// seam changes. Depot only becomes active once its env is set; with none, the http
// builder is chosen exactly as before.
export function selectRuntime(config: Config, log: Logger): Runtime {
  if (config.runtime === 'memory') {
    log.warn('runtime=memory: deploys will be recorded but nothing will be hosted');
    return new MemoryRuntime();
  }
  return new container.ContainerRuntime(
    config.builder === 'depot' ? buildDepotBuilder(config, log) : buildHttpBuilder(config, log),
  );
}

function buildHttpBuilder(config: Config, log: Logger): container.ContainerBuilder {
  if (config.build.host === '') {
    throw new Error('TWO80_BUILD_HOST is required (or set TWO80_RUNTIME=memory, or TWO80_BUILDER=depot)');
  }
  if (config.build.token === '') {
    log.warn('TWO80_BUILD_TOKEN unset: the build host is reached without authentication');
  }
  return new container.HttpBuilder({ baseUrl: config.build.host, token: config.build.token });
}

function buildDepotBuilder(config: Config, log: Logger): container.ContainerBuilder {
  const missing = [
    ['DEPOT_TOKEN', config.depot.token],
    ['CLOUDFLARE_ACCOUNT_ID', config.cloudflare.accountId],
    ['CLOUDFLARE_API_TOKEN', config.cloudflare.apiToken],
  ].filter(([, v]) => v === '').map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`TWO80_BUILDER=depot requires ${missing.join(', ')}`);
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
    sessionTtlSecs: config.sessionTtlDays * 24 * 60 * 60,
    rate: { windowSecs: config.loginRate.windowSecs, max: config.loginRate.max },
  });
}

// sweepExpired is the scheduled cleanup's core, factored out of the Worker so it is
// testable against any Store: delete expired sessions, device codes, and lapsed
// login-rate windows, and log the counts.
export async function sweepExpired(store: Store, log: Logger, now: number): Promise<ExpiryCounts> {
  const counts = await store.deleteExpired(now);
  log.info('scheduled cleanup', {
    sessions: counts.sessions,
    deviceCodes: counts.deviceCodes,
    rateLimits: counts.rateLimits,
  });
  return counts;
}
