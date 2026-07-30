// Assembly point for the gateway Worker. Isolate-scoped pieces (provider
// registry, signer) are built once; store + Auth are built per request and the
// pg client is closed after the response, as the control plane does it.

import { Auth } from '@280/backend/authsvc';
import { GoogleProvider, EntraProvider, type OidcProvider } from '@280/backend/auth/oidc';
import { newPgStore } from '@280/backend/store';
import type { Store } from '@280/backend/seams';
import { Authorizer } from './access.js';
import { confineRedirect, Gateway, type Logger } from './gateway.js';
import { IdentitySigner, publicJwkFromPrivate } from './identity.js';
import type { ProviderLink } from './pages.js';
import { ContainerUpstream, type AppContainers } from './upstream.js';
import { readConfig, type Config, type Env } from './config.js';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Continue with Google',
  microsoft: 'Continue with Microsoft',
};

export interface GatewayStatics {
  config: Config;
  registry: Record<string, OidcProvider>;
  links: ProviderLink[];
  signer: IdentitySigner;
  publicJwks: Record<string, JsonWebKey>;
  containers: AppContainers;
  log: Logger;
}

// Reaches each app's container through the App280Container Durable Object
// namespace, one instance per script name. Returns null when the binding is
// absent so the proxy answers "not reachable" instead of throwing.
class NamespaceContainers implements AppContainers {
  constructor(private readonly ns: DurableObjectNamespace | undefined) {}

  forScript(script: string): Fetcher | null {
    if (this.ns === undefined) return null;
    return this.ns.get(this.ns.idFromName(script));
  }
}

// Throws on the two misconfigurations that would otherwise fail silently: no
// provider (nobody can sign in) and no signing key (no identity can be minted).
export function buildStatics(env: Env, log: Logger): GatewayStatics {
  const config = readConfig(env);
  const { registry, links } = buildProviders(config);
  if (links.length === 0) {
    throw new Error('no OIDC provider configured: set GOOGLE_CLIENT_ID/SECRET and/or ENTRA_CLIENT_ID/SECRET');
  }
  const { signer, publicJwks } = buildSigner(config);
  const containers = new NamespaceContainers(env.APP_CONTAINER);
  return { config, registry, links, signer, publicJwks, containers, log };
}

export function buildProviders(config: Config): {
  registry: Record<string, OidcProvider>;
  links: ProviderLink[];
} {
  const registry: Record<string, OidcProvider> = {};
  const links: ProviderLink[] = [];

  if (config.google.clientId !== '' && config.google.clientSecret !== '') {
    registry.google = new GoogleProvider({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
    });
    links.push({ name: 'google', label: PROVIDER_LABELS.google! });
  }
  if (config.entra.clientId !== '' && config.entra.clientSecret !== '') {
    registry.microsoft = new EntraProvider({
      clientId: config.entra.clientId,
      clientSecret: config.entra.clientSecret,
      tenant: config.entraTenant,
    });
    links.push({ name: 'microsoft', label: PROVIDER_LABELS.microsoft! });
  }
  return { registry, links };
}

export function buildSigner(config: Config): {
  signer: IdentitySigner;
  publicJwks: Record<string, JsonWebKey>;
} {
  if (config.idSigningJwk === '') {
    throw new Error('ID_SIGNING_JWK is required: the gateway cannot mint identities without a signing key');
  }
  let privateJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(config.idSigningJwk) as JsonWebKey;
  } catch {
    throw new Error('ID_SIGNING_JWK is not valid JSON');
  }
  const signer = new IdentitySigner({
    kid: config.idSigningKid,
    privateJwk,
    issuer: config.idIssuer,
    ttlSecs: config.idTtlSecs,
  });
  const publicJwks = { [config.idSigningKid]: publicJwkFromPrivate(privateJwk, config.idSigningKid) };
  return { signer, publicJwks };
}

// The gateway's app-host redirect guard is injected so Auth's start/callback
// confine to *.280apps.run instead of a single origin.
export function buildAuth(store: Store, config: Config, registry: Record<string, OidcProvider>): Auth {
  return new Auth(store, {
    providers: registry,
    apiOrigin: config.authOrigin,
    frontendOrigin: config.fallbackRedirect,
    cookieDomain: config.cookieDomain,
    sessionTtlSecs: config.sessionTtlSecs,
    rate: config.loginRate,
    resolveRedirect: (raw) => {
      const dest = confineRedirect(raw, {
        appDomain: config.appDomain,
        authHost: config.authHost,
        hostSuffix: config.hostSuffix,
      });
      return dest === '' ? config.fallbackRedirect : dest;
    },
  });
}

export function requestGateway(s: GatewayStatics): { gateway: Gateway; close: () => Promise<void> } {
  const store = newPgStore(s.config.dbConnectionString, s.config.dbSchema);
  const auth = buildAuth(store, s.config, s.registry);
  const gateway = new Gateway({
    auth,
    signer: s.signer,
    authz: new Authorizer(store),
    audit: store,
    upstream: new ContainerUpstream(s.containers),
    hosts: { appDomain: s.config.appDomain, authHost: s.config.authHost, hostSuffix: s.config.hostSuffix },
    authOrigin: s.config.authOrigin,
    cookieDomain: s.config.cookieDomain,
    sessionTtlSecs: s.config.sessionTtlSecs,
    providers: s.links,
    publicJwks: s.publicJwks,
    fallbackRedirect: s.config.fallbackRedirect,
    logger: s.log,
  });
  return { gateway, close: () => store.close() };
}
