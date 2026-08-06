// Deploy & auth wire types, their zod schemas, and the two content derivations
// (DigestBytes, CanonicalDigest). Parsing mirrors Go encoding/json: unknown fields
// preserved, absent/null optionals become the Go zero value (a strict schema would
// break old clients). Spec: contracts/deploy/deploy.go, contracts/auth/auth.go (normative).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { errorSchema } from './errors.js';

// MaxBuildContextBytes caps the total size of an uploaded container build
// context, the coarse guard preflight applies before any state changes.
export const MAX_BUILD_CONTEXT_BYTES = 512 << 20; // 512 MiB

// Hex-encoded SHA-256 of blob content.
export type Digest = string;

// zero-value helpers: absent/null => Go zero value
const str = (d = '') =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? d);
const num = (d = 0) =>
  z
    .number()
    .nullish()
    .transform((v) => v ?? d);
const bool = (d = false) =>
  z
    .boolean()
    .nullish()
    .transform((v) => v ?? d);
const arr = <T extends z.ZodTypeAny>(el: T) =>
  z
    .array(el)
    .nullish()
    .transform((v) => v ?? ([] as z.infer<T>[]));

export const identitySchema = z
  .object({
    appId: str(),
    slug: str(),
    framework: str(), // "next" | "static"
    gitRemote: str(),
    clientRef: str(),
    forceNew: bool(),
  })
  .passthrough();
export type Identity = z.infer<typeof identitySchema>;

export const blobInfoSchema = z
  .object({
    path: str(), // context-relative path of a build-context file
    digest: str(),
    size: num(),
  })
  .passthrough();
export type BlobInfo = z.infer<typeof blobInfoSchema>;

export const MANIFEST_KIND_CONTAINER = 'container';

// BuildSpec is how the runtime turns the uploaded build context into a runnable
// image: which Dockerfile to build, the port the app listens on, and a builder
// tag for diagnostics ('next' | 'static' | 'dockerfile').
export const buildSpecSchema = z
  .object({
    builder: str(),
    dockerfile: str(), // context-relative path, e.g. "Dockerfile"
    port: num(),
  })
  .passthrough();
export type BuildSpec = z.infer<typeof buildSpecSchema>;

const ZERO_BUILD: BuildSpec = { builder: '', dockerfile: '', port: 0 };

// EgressCredential binds one allowed host to a platform-held secret the outbound
// handler attaches in-flight. Only the secret NAME travels on the wire; its value
// lives in the Worker vault and never enters the app's container. header defaults
// to authorization and scheme to Bearer, so `{host, secret}` covers bearer APIs;
// a raw-value header (e.g. apikey) sets scheme to ''.
export const egressCredentialSchema = z
  .object({
    host: str(),
    secret: str(), // the secret's name; the value is resolved from the vault at call time
    header: str('authorization'),
    scheme: str('Bearer'),
  })
  .passthrough();
export type EgressCredential = z.infer<typeof egressCredentialSchema>;

// EgressPolicy is an app's outbound contract, derived from its 280.json: the hosts
// it may reach and the credentials the handler attaches per host. Anything not in
// allowedHosts fails closed (HTTP 520) at the container boundary. Rides in the
// Manifest so a policy change re-derives the deploy id and redeploys.
export const egressPolicySchema = z
  .object({
    allowedHosts: arr(z.string()),
    credentials: arr(egressCredentialSchema),
  })
  .passthrough();
export type EgressPolicy = z.infer<typeof egressPolicySchema>;

const ZERO_EGRESS: EgressPolicy = { allowedHosts: [], credentials: [] };

// The three ways an app decides who may open it at all, before any route gate:
// invited (only principals with a grant), anyone-at-tenant (any signed-in viewer
// whose email domain matches the owner's), public (anyone on the internet, no
// sign-in; served with an anonymous viewer identity). Absent or unknown means
// invited, the fail-closed default.
export const APP_ACCESS = {
  Invited: 'invited',
  AnyoneAtTenant: 'anyone-at-tenant',
  Public: 'public',
} as const;
export type AppAccess = (typeof APP_ACCESS)[keyof typeof APP_ACCESS];

export function isAppAccess(v: string): v is AppAccess {
  return v === APP_ACCESS.Invited || v === APP_ACCESS.AnyoneAtTenant || v === APP_ACCESS.Public;
}

// Where an app's effective access mode came from: the live deploy's 280.json, or
// the owner's dashboard override (which wins durably across redeploys).
export type AppAccessSource = 'manifest' | 'dashboard';

// Domains of consumer mail providers. An owner signed up with one of these has no
// org, so anyone-at-tenant keyed to it would mean "anyone at gmail.com" — the
// gateway refuses to admit on such a tenant and the share dialog warns/disables.
const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com',
  'naver.com', 'daum.net', 'web.de', 't-online.de',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net',
]);

export function isConsumerEmailDomain(domain: string): boolean {
  return CONSUMER_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

// The four app roles (tier 1), highest first. Ranked so a gate "at least admin" is
// a single comparison and the owner-only default is the top of the ladder.
export const APP_ROLE_ORDER = ['owner', 'admin', 'editor', 'viewer'] as const;

export function appRoleRank(role: string): number {
  const i = (APP_ROLE_ORDER as readonly string[]).indexOf(role);
  return i < 0 ? -1 : APP_ROLE_ORDER.length - i; // owner=4 … viewer=1, unknown=0
}

// appRoleAtLeast reports whether `have` meets or exceeds `need` on the app-role
// ladder. An unknown/empty `have` never satisfies a gate (fail closed).
export function appRoleAtLeast(have: string, need: string): boolean {
  const h = appRoleRank(have);
  return h > 0 && h >= appRoleRank(need);
}

// RouteGate is the normalized (CLI-produced) form of one 280.json route rule: a
// path glob and exactly one requirement — an app_role floor OR a feature role. The
// human 280.json nests these under `require`; the CLI flattens to this wire shape.
export const routeGateSchema = z
  .object({
    path: str(),
    appRole: str(), // '' or an app role the viewer must meet or exceed
    role: str(), // '' or a feature role the viewer must hold
  })
  .passthrough();
export type RouteGate = z.infer<typeof routeGateSchema>;

// The gate an undeclared route resolves to: app Owner only. This is the
// no-unguarded-route rule (design §07) — manifest drift makes a route unreachable,
// never open.
export const OWNER_ONLY_GATE: RouteGate = { path: '', appRole: 'owner', role: '' };

// normalizeEgressPolicy is the one place the allowlist is derived, so the CLI that
// builds the policy and the runtime that applies it never disagree: a credential's
// host is implicitly allowed, hosts are lowercased/trimmed, and duplicates drop.
export function normalizeEgressPolicy(p: EgressPolicy): EgressPolicy {
  const credentials = p.credentials
    .map((c) => ({ ...c, host: c.host.trim().toLowerCase() }))
    .filter((c) => c.host !== '');
  const hosts = new Set<string>();
  for (const h of p.allowedHosts) {
    const host = h.trim().toLowerCase();
    if (host !== '') hosts.add(host);
  }
  for (const c of credentials) hosts.add(c.host);
  return { allowedHosts: [...hosts].sort(), credentials };
}

// Manifest is a container build-context descriptor: the build recipe plus every
// file in the context, each content-addressed so the deploy loop transfers only
// what the server lacks. It also carries the app's trust boundary from 280.json —
// egress (5.6), access mode, feature roles, route gates, and declared secret names —
// so a change to any of them re-derives the deploy id (see canonicalDigest) and the
// platform re-registers the policy on the next push. Replaces the retired
// Workers-for-Platforms bundle shape.
export const manifestSchema = z
  .object({
    kind: str(),
    build: buildSpecSchema.nullish().transform((v) => v ?? ZERO_BUILD),
    files: arr(blobInfoSchema),
    egress: egressPolicySchema.nullish().transform((v) => v ?? ZERO_EGRESS),
    access: str(APP_ACCESS.Invited),
    roles: arr(z.string()),
    routes: arr(routeGateSchema),
    secrets: arr(z.string()),
  })
  .passthrough();
export type Manifest = z.infer<typeof manifestSchema>;

// AppPolicy is the enforced slice of a manifest the gateway reads per request and
// the share dialog reads to offer roles: the access mode, the feature-role
// vocabulary, the route gates, the declared secret names, and the owner's tenant
// (for anyone-at-tenant). Persisted when a deploy goes live.
export interface AppPolicy {
  appId: string;
  access: AppAccess; // effective mode: the dashboard override when set, else the manifest's
  accessSource: AppAccessSource;
  roles: string[];
  routes: RouteGate[];
  secrets: string[];
  ownerTenant: string; // '' until the owner is known; anyone-at-tenant fails closed while empty
  updatedAt: number;
}

// appPolicyFromManifest lifts the enforced sections out of a manifest into the
// shape the store persists. ownerTenant/updatedAt/accessSource are filled by the caller.
export function appPolicyFromManifest(
  m: Manifest,
): Omit<AppPolicy, 'appId' | 'ownerTenant' | 'updatedAt' | 'accessSource'> {
  return {
    access: isAppAccess(m.access ?? '') ? (m.access as AppAccess) : APP_ACCESS.Invited,
    roles: [...(m.roles ?? [])],
    routes: [...(m.routes ?? [])],
    secrets: [...(m.secrets ?? [])],
  };
}

// pathMatches tests a request path against a route glob. `*` matches any run of
// characters (so "/admin/*" covers "/admin/users"); everything else is literal.
// A bare "/admin/*" also matches "/admin" itself, the intuitive reading of "the
// admin area". Anchored at both ends.
export function pathMatches(glob: string, path: string): boolean {
  if (glob === path) return true;
  if (glob.endsWith('/*') && path === glob.slice(0, -2)) return true;
  const re = new RegExp('^' + glob.split('*').map(escapeRegex).join('.*') + '$');
  return re.test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// resolveRouteGate picks the gate a request path must clear: the most specific
// declared route that matches (longest literal glob wins), or the owner-only
// default when none matches. `declared` distinguishes an explicit gate from the
// fail-closed default so the deploy diff can flag undeclared routes.
export function resolveRouteGate(routes: RouteGate[], path: string): { gate: RouteGate; declared: boolean } {
  let best: RouteGate | null = null;
  let bestScore = -1;
  for (const r of routes) {
    if (r.path === '' || !pathMatches(r.path, path)) continue;
    const score = r.path.replace(/\*/g, '').length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  if (best === null) return { gate: OWNER_ONLY_GATE, declared: false };
  return { gate: best, declared: true };
}

// The access the gateway resolved for one viewer on one app: their effective app
// role and feature role. Empty appRole means no grant at all.
export interface EffectiveAccess {
  appRole: string;
  featureRole: string;
}

// routeGateSatisfied is the single gate decision, shared by the gateway (enforce)
// and the CLI diff (explain). An app Owner reaches their whole app; otherwise the
// gate's one requirement — an app-role floor or an exact feature role — must hold.
export function routeGateSatisfied(gate: RouteGate, eff: EffectiveAccess): boolean {
  if (eff.appRole === 'owner') return true;
  if (gate.appRole !== '') return appRoleAtLeast(eff.appRole, gate.appRole);
  if (gate.role !== '') return eff.featureRole === gate.role;
  return false;
}

// describeGate renders a gate for the deploy diff and share UI: "app admin+",
// "role: manager", or "Owner-only (undeclared)" for the fail-closed default.
export function describeGate(gate: RouteGate, declared: boolean): string {
  if (!declared) return 'Owner-only (undeclared)';
  if (gate.appRole !== '') return `app ${gate.appRole}+`;
  if (gate.role !== '') return `role: ${gate.role}`;
  return 'Owner-only';
}

// ViewAsTarget is who a dashboard preview renders the app as: the owner
// themselves (none), the owner's identity at a lower role (role), or a specific
// person (user). Baked into the preview grant at creation and interpreted at mint.
export const viewAsTargetSchema = z.union([
  z.object({ kind: z.literal('none') }).passthrough(),
  z.object({ kind: z.literal('role'), appRole: str(), featureRole: str() }).passthrough(),
  z.object({ kind: z.literal('user'), email: str() }).passthrough(),
]);
export type ViewAsTarget = z.infer<typeof viewAsTargetSchema>;

// The preview-grant request body; the app is in the path and the acting owner is
// the session. An absent viewAs previews as the owner.
export const previewGrantRequestSchema = z
  .object({
    viewAs: viewAsTargetSchema.nullish().transform((v) => v ?? ({ kind: 'none' } as ViewAsTarget)),
  })
  .passthrough();
export type PreviewGrantRequest = z.infer<typeof previewGrantRequestSchema>;

// PreviewGrant is one owner-authorized, short-lived, revocable permission to mint
// preview identities for one app. Only the opaque token's hash is stored (the
// device-code discipline); the control plane writes it and the gateway reads it
// over the shared store, re-checking expiry, revocation, and the owner's role on
// every mint.
export interface PreviewGrant {
  tokenHash: string;
  appId: string;
  ownerUserId: string;
  viewAs: ViewAsTarget;
  expiresAt: number; // unix seconds
  revoked: boolean;
}

// Callers treat unknown states as "in progress".
export const State = {
  Uploading: 'uploading',
  Activating: 'activating',
  WaitingSecrets: 'waiting_secrets',
  Live: 'live',
  Failed: 'failed',
} as const;
export type State = (typeof State)[keyof typeof State];

export function stateTerminal(s: string): boolean {
  return s === State.Live || s === State.Failed;
}

export const Resolution = {
  Existing: 'existing',
  Created: 'created',
  FingerprintLinked: 'fingerprint_linked',
} as const;
export type Resolution = (typeof Resolution)[keyof typeof Resolution];

export const appSchema = z
  .object({
    id: str(),
    slug: str(),
    url: str(), // https://<slug>-<token>.280apps.run
  })
  .passthrough();
export type App = z.infer<typeof appSchema>;

export const deleteRequestSchema = z
  .object({
    appId: str(),
    confirm: str(),
  })
  .passthrough();
export type DeleteRequest = z.infer<typeof deleteRequestSchema>;

export const deleteResultSchema = z
  .object({
    app: appSchema,
    deleted: bool(),
  })
  .passthrough();
export type DeleteResult = z.infer<typeof deleteResultSchema>;

export const syncRequestSchema = z
  .object({
    identity: identitySchema,
    manifest: manifestSchema,
  })
  .passthrough();
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export const syncResultSchema = z
  .object({
    app: appSchema,
    resolution: str(),
    deployId: str(),
    state: str(),
    missing: arr(z.string()), // digests the server still lacks; empty => just poll
    failure: errorSchema.nullish().transform((v) => v ?? undefined),
  })
  .passthrough();
export type SyncResult = z.infer<typeof syncResultSchema>;

export const deployStatusSchema = z
  .object({
    state: str(),
    url: str(),
    // A one-line server-side note the CLI relays verbatim (e.g. the dashboard
    // access override diverging from 280.json). Empty means nothing to say.
    notice: str(''),
    secretNotice: str(''),
    failure: errorSchema.nullish().transform((v) => v ?? undefined),
  })
  .passthrough();
export type DeployStatus = z.infer<typeof deployStatusSchema>;

export const deviceCodeResponseSchema = z
  .object({
    deviceCode: str(),
    userCode: str(),
    verificationUri: str(),
    expiresIn: num(),
    interval: num(),
  })
  .passthrough();
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;

export const tokenRequestSchema = z
  .object({ deviceCode: str() })
  .passthrough();
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export const tokenResponseSchema = z
  .object({ token: str() })
  .passthrough();
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

// The approving user comes from the browser session, so the body carries only the code the human typed.
export const approveRequestSchema = z
  .object({ userCode: str() })
  .passthrough();
export type ApproveRequest = z.infer<typeof approveRequestSchema>;

// Like approve: the owner is the session, so only the typed confirmation rides in the body; the app is in the path.
export const deleteAppRequestSchema = z
  .object({ confirm: str() })
  .passthrough();
export type DeleteAppRequest = z.infer<typeof deleteAppRequestSchema>;

// The hex SHA-256 of raw content.
export function digestBytes(data: Uint8Array): Digest {
  return createHash('sha256').update(data).digest('hex');
}

// Orders two strings by their UTF-8 bytes, matching Go's string <.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sortedByPath(items: BlobInfo[]): BlobInfo[] {
  return [...items].sort((x, y) => byteCompare(x.path, y.path));
}

// canonicalDigest is the manifest's content digest: the build recipe followed by
// every file sorted by path. Order-independent, and no field can change without
// changing it, so the derived deploy id is a pure function of what is deployed.
export function canonicalDigest(m: Manifest): Digest {
  const h = createHash('sha256');
  h.update(`kind:${m.kind}\n`);
  h.update(`build:${m.build.builder}:${m.build.dockerfile}:${m.build.port}\n`);
  for (const f of sortedByPath(m.files)) {
    h.update(`file:${f.path}:${f.digest}:${f.size}\n`);
  }
  const eg = normalizeEgressPolicy(m.egress ?? ZERO_EGRESS);
  for (const host of eg.allowedHosts) h.update(`egress-host:${host}\n`);
  for (const c of [...eg.credentials].sort((a, b) => byteCompare(a.host, b.host))) {
    h.update(`egress-cred:${c.host}:${c.header}:${c.scheme}:${c.secret}\n`);
  }
  // Access mode, feature roles, route gates, and secret names are the app's trust
  // boundary, so a change to any must produce a new deploy id (and re-register the
  // policy). Each is emitted only when it departs from the empty/default value, so a
  // manifest that declares no policy hashes exactly as it did before these fields
  // existed (the same backward-compatible discipline egress follows). Roles/secrets
  // are sorted (order-independent); routes are sorted by path since matching is by
  // specificity, not declaration order.
  const access = m.access ?? '';
  if (access !== '' && access !== APP_ACCESS.Invited) h.update(`access:${access}\n`);
  for (const role of [...(m.roles ?? [])].sort(byteCompare)) h.update(`role:${role}\n`);
  for (const g of [...(m.routes ?? [])].sort((a, b) => byteCompare(a.path, b.path))) {
    h.update(`route:${g.path}:${g.appRole}:${g.role}\n`);
  }
  for (const s of [...(m.secrets ?? [])].sort(byteCompare)) h.update(`secret:${s}\n`);
  return h.digest('hex');
}

// manifestBlobs returns every blob a manifest names. Callers derive Missing from
// it; duplicate digests (identical bytes at different paths) are deduped there.
export function manifestBlobs(m: Manifest): BlobInfo[] {
  return [...m.files];
}
