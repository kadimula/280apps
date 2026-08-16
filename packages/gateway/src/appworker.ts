import { IdentityVerifier, IdentityError, type VerifiedIdentity } from '@280/contracts/identity';
import type { RouteGate } from '@280/contracts';
import { resolvePlatformTopology } from '@280/contracts/platform-config';
import { gateForPath } from './routegate.js';
import { ID_COOKIE, PREVIEW_COOKIE, SESSION_COOKIE, VIEW_COOKIE, readCookie, serializeCookie, stampIdentity } from './cookies.js';
import type { GatewayBinding, MintResult } from './mint.js';
import { denyPage, errorPage, unavailablePage } from './pages.js';

const DEFAULT_IDENTITY_CLOCK_SKEW_SECONDS = 5;
const JWKS_CACHE_TTL_SECONDS = 300;
const PREVIEW_PATH = '/__280/preview';
const PREVIEW_COOKIE_TTL_SECONDS = 1800;
const DEFAULT_FRAME_ANCESTORS = resolvePlatformTopology({}).dashboardOrigin;
const ANONYMOUS_TOKEN_CACHE_MARGIN_SECONDS = 5;

export interface AppWorkerEnv {
  APP?: DurableObjectNamespace; // App280Container namespace binding
  GATEWAY: GatewayBinding; // GatewayRPC service binding
  APP_SCRIPT_NAME?: string; // renewals
  IDENTITY_TOKEN_ISSUER?: string; // https://auth.280apps.run
  IDENTITY_CLOCK_SKEW_SECONDS?: string; // 5
  APP_ROUTE_POLICY?: string; // {"routes":[{"path":"/admin/*","appRole":"admin"}]}
  APP_FRAME_ANCESTORS?: string; // https://280apps.com
}

export interface AppWorkerDeps {
  container: Fetcher;
  currentEpochSeconds?: () => number;
}

let jwksCache: { keysById: Record<string, JsonWebKey>; expiresAt: number } | null = null;
const anonymousTokenCache = new Map<string, { token: string; expiresAt: number }>();

export function __resetJwksCache(): void {
  jwksCache = null;
}

export function __resetAnonymousTokenCache(): void {
  anonymousTokenCache.clear();
}


// Entry point for each app here
export async function handleAppRequest(
  request: Request,
  env: AppWorkerEnv,
  deps: AppWorkerDeps,
): Promise<Response> {
  // Resolve request and Worker configuration.
  const requestUrl = new URL(request.url);
  const appHost = requestUrl.hostname;
  const requestPath = requestUrl.pathname;
  const currentEpochSeconds = deps.currentEpochSeconds ?? (() => Math.floor(Date.now() / 1000));
  const identityIssuer = env.IDENTITY_TOKEN_ISSUER;
  const allowedClockSkewSeconds = positiveIntegerOrDefault(
    env.IDENTITY_CLOCK_SKEW_SECONDS,
    DEFAULT_IDENTITY_CLOCK_SKEW_SECONDS,
  );
  const appScriptName = env.APP_SCRIPT_NAME ?? '';
  const frameAncestors = (env.APP_FRAME_ANCESTORS ?? '').trim() || DEFAULT_FRAME_ANCESTORS;

  // Fail closed when route policy is invalid.
  let routeGates: RouteGate[];
  try {
    routeGates = parseRouteGates(env.APP_ROUTE_POLICY);
  } catch {
    return htmlResponse(errorPage(), 500);
  }

  // Exchange preview grants before normal authentication.
  const identityGateway = env.GATEWAY;
  if (requestPath === PREVIEW_PATH) {
    return handlePreviewBootstrap(requestUrl, identityGateway, appScriptName, appHost);
  }

  // Prefer a valid local identity token.
  const identityToken = readCookie(request, ID_COOKIE);
  if (identityToken !== '') {
    try {
      const verifiedIdentity = await verifyIdentityToken(identityToken, {
        appHost,
        identityIssuer,
        allowedClockSkewSeconds,
        identityGateway,
        currentEpochSeconds,
      });
      return serveAuthorizedRequest(
        request,
        identityToken,
        verifiedIdentity,
        routeGates,
        requestPath,
        deps.container,
        null,
        frameAncestors,
      );
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
    }
  }

  const previewGrant = readCookie(request, PREVIEW_COOKIE);
  const sessionToken = readCookie(request, SESSION_COOKIE);

  // Reuse anonymous identities for cookieless requests.
  if (previewGrant === '' && sessionToken === '') {
    const cachedAnonymousToken = anonymousTokenCache.get(appHost);
    if (
      cachedAnonymousToken !== undefined &&
      cachedAnonymousToken.expiresAt > currentEpochSeconds() + ANONYMOUS_TOKEN_CACHE_MARGIN_SECONDS
    ) {
      try {
        const verifiedIdentity = await verifyIdentityToken(cachedAnonymousToken.token, {
          appHost,
          identityIssuer,
          allowedClockSkewSeconds,
          identityGateway,
          currentEpochSeconds,
        });
        const identityCookie = serializeCookie(ID_COOKIE, cachedAnonymousToken.token, {
          maxAge: cachedAnonymousToken.expiresAt - currentEpochSeconds(),
        });
        return serveAuthorizedRequest(
          request,
          cachedAnonymousToken.token,
          verifiedIdentity,
          routeGates,
          requestPath,
          deps.container,
          identityCookie,
          frameAncestors,
        );
      } catch (error) {
        if (!(error instanceof IdentityError)) throw error;
        anonymousTokenCache.delete(appHost);
      }
    }
  }

  // Mint or refresh identity through the gateway.
  let mintResult: MintResult;
  try {
    mintResult =
      previewGrant !== ''
        ? await identityGateway.mintPreview({ grant: previewGrant, script: appScriptName, host: appHost })
        : await identityGateway.mint({
            sessionToken,
            viewCookie: readCookie(request, VIEW_COOKIE),
            script: appScriptName,
            host: appHost,
          });
  } catch {
    return htmlResponse(unavailablePage(), 503);
  }

  if (mintResult.kind === 'login') {
    return new Response(null, { status: 302, headers: { location: mintResult.url } });
  }
  if (mintResult.kind === 'deny') {
    return htmlResponse(denyPage(mintResult.reason), 403);
  }

  // Verify and forward the newly minted identity.
  let verifiedIdentity: VerifiedIdentity;
  try {
    verifiedIdentity = await verifyIdentityToken(mintResult.token, {
      appHost,
      identityIssuer,
      allowedClockSkewSeconds,
      identityGateway,
      currentEpochSeconds,
    });
  } catch {
    return htmlResponse(errorPage(), 500);
  }

  if (verifiedIdentity.claims.anon === true) {
    anonymousTokenCache.set(appHost, {
      token: mintResult.token,
      expiresAt: currentEpochSeconds() + mintResult.ttlSecs,
    });
  }
  const identityCookie = serializeCookie(ID_COOKIE, mintResult.token, {
    maxAge: mintResult.ttlSecs,
    partitioned: previewGrant !== '',
  });
  return serveAuthorizedRequest(
    request,
    mintResult.token,
    verifiedIdentity,
    routeGates,
    requestPath,
    deps.container,
    identityCookie,
    frameAncestors,
  );
}

async function handlePreviewBootstrap(
  requestUrl: URL,
  identityGateway: GatewayBinding,
  appScriptName: string,
  appHost: string,
): Promise<Response> {
  const previewGrant = requestUrl.searchParams.get('g') ?? '';
  if (previewGrant === '') return htmlResponse(errorPage(), 400);

  let mintResult: MintResult;
  try {
    mintResult = await identityGateway.mintPreview({ grant: previewGrant, script: appScriptName, host: appHost });
  } catch {
    return htmlResponse(unavailablePage(), 503);
  }
  if (mintResult.kind !== 'token') {
    return htmlResponse(
      denyPage(mintResult.kind === 'deny' ? mintResult.reason : 'This preview is not available.'),
      403,
    );
  }

  const responseHeaders = new Headers({ location: safeSameOriginPath(requestUrl.searchParams.get('to') ?? '') });
  responseHeaders.append(
    'set-cookie',
    serializeCookie(PREVIEW_COOKIE, previewGrant, {
      maxAge: PREVIEW_COOKIE_TTL_SECONDS,
      partitioned: true,
    }),
  );
  responseHeaders.append(
    'set-cookie',
    serializeCookie(ID_COOKIE, mintResult.token, { maxAge: mintResult.ttlSecs, partitioned: true }),
  );
  return new Response(null, { status: 302, headers: responseHeaders });
}

function safeSameOriginPath(candidatePath: string): string {
  return candidatePath.startsWith('/') && !candidatePath.startsWith('//') ? candidatePath : '/';
}

async function serveAuthorizedRequest(
  request: Request,
  identityToken: string,
  verifiedIdentity: VerifiedIdentity,
  routeGates: RouteGate[],
  requestPath: string,
  container: Fetcher,
  identityCookie: string | null,
  frameAncestors: string,
): Promise<Response> {
  const { claims } = verifiedIdentity;
  const accessDecision = gateForPath(
    routeGates,
    { appRole: claims.role, featureRole: claims.title },
    requestPath,
  );
  if (!accessDecision.allow) return htmlResponse(denyPage(accessDecision.reason), 403);

  const authenticatedRequest = stampIdentity(request, identityToken);
  const containerResponse = await container.fetch(authenticatedRequest);
  const responseHeaders = new Headers(containerResponse.headers);
  enforceFrameAncestors(responseHeaders, frameAncestors);
  if (claims.anon === true) responseHeaders.set('x-robots-tag', 'noindex');
  if (identityCookie !== null) responseHeaders.append('set-cookie', identityCookie);
  return new Response(containerResponse.body, {
    status: containerResponse.status,
    statusText: containerResponse.statusText,
    headers: responseHeaders,
  });
}

function enforceFrameAncestors(responseHeaders: Headers, frameAncestors: string): void {
  responseHeaders.delete('x-frame-options');
  const otherDirectives = (responseHeaders.get('content-security-policy') ?? '')
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '' && !directive.toLowerCase().startsWith('frame-ancestors'));
  responseHeaders.set('content-security-policy', [`frame-ancestors ${frameAncestors}`, ...otherDirectives].join('; '));
}

interface IdentityVerificationOptions {
  appHost: string;
  identityIssuer: string | undefined;
  allowedClockSkewSeconds: number;
  identityGateway: GatewayBinding;
  currentEpochSeconds: () => number;
}

async function verifyIdentityToken(
  identityToken: string,
  options: IdentityVerificationOptions,
): Promise<VerifiedIdentity> {
  const publicKeysById = await getPublicJwks(options.identityGateway, options.currentEpochSeconds, false);
  try {
    return await createIdentityVerifier(publicKeysById, options).verify(identityToken, { audience: options.appHost });
  } catch (error) {
    if (error instanceof IdentityError && error.message.includes('unknown signing key')) {
      const refreshedPublicKeysById = await getPublicJwks(
        options.identityGateway,
        options.currentEpochSeconds,
        true,
      );
      return createIdentityVerifier(refreshedPublicKeysById, options).verify(identityToken, {
        audience: options.appHost,
      });
    }
    throw error;
  }
}

function createIdentityVerifier(
  publicKeysById: Record<string, JsonWebKey>,
  options: Pick<IdentityVerificationOptions, 'identityIssuer' | 'allowedClockSkewSeconds' | 'currentEpochSeconds'>,
): IdentityVerifier {
  return new IdentityVerifier({
    publicJwks: publicKeysById,
    issuer: options.identityIssuer,
    skewSecs: options.allowedClockSkewSeconds,
    now: options.currentEpochSeconds,
  });
}

async function getPublicJwks(
  identityGateway: GatewayBinding,
  currentEpochSeconds: () => number,
  forceRefresh: boolean,
): Promise<Record<string, JsonWebKey>> {
  if (!forceRefresh && jwksCache !== null && jwksCache.expiresAt > currentEpochSeconds()) {
    return jwksCache.keysById;
  }

  const jwksDocument = await identityGateway.jwks();
  const keysById: Record<string, JsonWebKey> = {};
  for (const publicKey of jwksDocument.keys) {
    const keyId = (publicKey as { kid?: unknown }).kid;
    if (typeof keyId === 'string' && keyId !== '') keysById[keyId] = publicKey;
  }
  jwksCache = {
    keysById,
    expiresAt: currentEpochSeconds() + JWKS_CACHE_TTL_SECONDS,
  };
  return keysById;
}

function parseRouteGates(serializedPolicy: string | undefined): RouteGate[] {
  if (serializedPolicy === undefined || serializedPolicy === '') return [];
  const policy = JSON.parse(serializedPolicy) as { routes?: unknown };
  return Array.isArray(policy.routes) ? (policy.routes as RouteGate[]) : [];
}

function positiveIntegerOrDefault(value: string | undefined, defaultValue: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : defaultValue;
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
