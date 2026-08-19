// @two80/sdk: the only identity code a 280 app ever contains. The gateway authenticates
// the caller, gates the route, verifies the signed identity, strips every client
// x-280-* header, then forwards one short-lived claim set as X-280-Identity. The
// container's sole ingress is that gateway, so the app trusts the header and this SDK
// only decodes it into one object — the user, a can() capability check, and a scope()
// resolver. Apps write no auth: no sessions, no token handling, no user table.
//
//   import { identity } from "@two80/sdk";
//   const { user, can, scope } = await identity(request);
//   user.email            // resolved by the gateway, not by app code
//   can("approvals.edit") // true when the viewer holds that feature role
//   scope("salaries")     // the advisory data scope, or null

import { ID_HEADER, IdentityError, decodeIdentityToken, type IdentityClaims } from '@280/contracts/identity';

export { ID_HEADER, IdentityError };
export type { IdentityClaims };

export {
  googleSheets,
  IntegrationRequestError,
  type NotReadyCode,
  type GoogleSheetsClient,
  type GoogleSheetsOptions,
  type SheetsReadInput,
  type SheetsReadResult,
  type SheetsWriteInput,
  type SheetsWriteResult,
  type SheetsDeleteRowsInput,
  type SheetsDeleteRowsResult,
} from './googleSheets.js';

export {
  supabaseTables,
  type SupabaseTablesClient,
  type SupabaseTablesOptions,
  type SupabaseFilterOp,
  type SupabaseFilter,
  type TablesSelectInput,
  type TablesSelectResult,
  type TablesInsertInput,
  type TablesInsertResult,
  type TablesUpdateInput,
  type TablesUpdateResult,
  type TablesDeleteInput,
  type TablesDeleteResult,
} from './supabaseTables.js';

export interface User280 {
  sub: string;
  email: string;
  tenant: string;
  name: string;
}

// The one object an app reads per request. can()/scope() are the gateway-resolved
// grants; role/title are exposed directly for apps that branch on them.
export interface Identity280 {
  user: User280;
  can(capability: string): boolean;
  scope(name: string): unknown;
  // False when the request carried no identity header (the platform's expected
  // "no authenticated caller" state): every field then holds a safe empty value
  // and can()/scope() return false/null, so an app branches on it instead of
  // wrapping identity() in try/catch. True once a real identity was decoded.
  present: boolean;
  role: string; // the viewer's app role: '' | owner | admin | editor | viewer
  title: string; // the viewer's feature role, '' if none
  // True on the platform-minted anonymous viewer a public app serves to visitors
  // with no session (user.email is '' then). Branch on this before writes or
  // per-user rows: `if (identity.anonymous) ...`.
  anonymous: boolean;
  claims: IdentityClaims;
}

// Anything the SDK can read a header off: a Fetch Request, a Headers, or Next's
// headers() result — all expose `.get(name)`; a Request nests it under `.headers`.
export interface HeaderSource {
  get(name: string): string | null | undefined;
}
export type RequestLike = HeaderSource | { headers: HeaderSource };

export interface SdkApiOptions {
  origin?: string;
}

export function sdkApiUrl(path: string, opts: SdkApiOptions = {}): URL {
  if (path !== '/v1/sdk' && !path.startsWith('/v1/sdk/')) {
    throw new Error('280 SDK API paths must start with /v1/sdk/');
  }
  let origin: URL;
  try {
    origin = new URL(opts.origin ?? readEnv('TWO80_API'));
  } catch {
    throw new Error('TWO80_API must be an HTTPS origin');
  }
  if (origin.protocol !== 'https:') throw new Error('TWO80_API must be an HTTPS origin');
  return new URL(path, origin);
}

// identity reads the gateway-stamped header off the request and returns the viewer.
// An absent header is the platform's expected not-ready state: identity resolves to
// a safe absent viewer (present: false) rather than throwing, so apps branch on
// present instead of wrapping the call in try/catch. A malformed token is a genuine
// failure (the gateway is the container's only ingress and signs valid tokens) and
// still throws IdentityError. The token is not re-verified here: the gateway already
// verified it (see @280/contracts decodeIdentityToken).
export async function identity(request: RequestLike): Promise<Identity280> {
  const token = readHeader(request, ID_HEADER);
  if (token === '') return absentIdentity();
  const { user, claims } = decodeIdentityToken(token);
  const caps = new Set(claims.caps);
  return {
    user,
    present: true,
    role: claims.role,
    title: claims.title,
    anonymous: claims.anon === true,
    claims,
    can: (capability: string) => caps.has(capability),
    scope: (name: string) => (name in claims.scope ? claims.scope[name] : null),
  };
}

const EMPTY_CLAIMS: IdentityClaims = {
  iss: '',
  aud: '',
  sub: '',
  email: '',
  tenant: '',
  name: '',
  app: '',
  role: '',
  title: '',
  caps: [],
  scope: {},
  iat: 0,
  exp: 0,
};

function absentIdentity(): Identity280 {
  return {
    user: { sub: '', email: '', tenant: '', name: '' },
    present: false,
    role: '',
    title: '',
    anonymous: false,
    claims: EMPTY_CLAIMS,
    can: () => false,
    scope: () => null,
  };
}

function readEnv(name: string): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[name];
  return typeof v === 'string' ? v : '';
}

function readHeader(request: RequestLike, name: string): string {
  const direct = request as HeaderSource;
  const src = typeof direct.get === 'function' ? direct : (request as { headers: HeaderSource }).headers;
  const v = src.get(name) ?? src.get(name.toLowerCase());
  return typeof v === 'string' ? v : '';
}
