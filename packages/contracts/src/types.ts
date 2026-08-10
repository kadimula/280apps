// Deploy & auth wire types, their zod schemas, and the two content derivations
// (DigestBytes, CanonicalDigest). Parsing mirrors Go encoding/json: unknown fields
// preserved, absent/null optionals become the Go zero value (a strict schema would
// break old clients). Spec: contracts/deploy/deploy.go, contracts/auth/auth.go (normative).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DeployCode, errorSchema } from './errors.js';
import { DeployErr } from './deploy/error.js';

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

// The closed set of egress credential types. `header` is the static path: the
// handler attaches a vault-held secret under an author-chosen header/scheme.
// `google-service-account` is minted at the edge: the platform exchanges a
// vault-held service-account JSON for a scoped Google access token. Absent type
// means `header`, the back-compatible default.
export const EGRESS_CREDENTIAL_TYPE = {
  Header: 'header',
  GoogleServiceAccount: 'google-service-account',
} as const;
export type EgressCredentialType = (typeof EGRESS_CREDENTIAL_TYPE)[keyof typeof EGRESS_CREDENTIAL_TYPE];

export function isEgressCredentialType(t: string): t is EgressCredentialType {
  return t === EGRESS_CREDENTIAL_TYPE.Header || t === EGRESS_CREDENTIAL_TYPE.GoogleServiceAccount;
}

// credentialType folds an absent/blank type to the default `header`. Callers still
// pass the result through isEgressCredentialType to reject an unknown recognized type.
export function credentialType(c: { type?: string }): string {
  return (c.type ?? '').trim() || EGRESS_CREDENTIAL_TYPE.Header;
}

// A `google-service-account` credential may only target Google's API surface: the
// exact apex `googleapis.com` or a label-boundary `*.googleapis.com` subdomain.
// Wildcards, paths, and leading dots are rejected so a typed credential can never
// be attached to an author-chosen host.
export function googleServiceAccountHostAllowed(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '' || h.startsWith('.') || h.includes('*') || h.includes('/')) return false;
  return h === 'googleapis.com' || h.endsWith('.googleapis.com');
}

// Worker binding/var names the platform roll owns. A credential secret (which the
// roll delivers as a Worker secret binding) must not collide with these or the
// TWO80_ platform namespace, or it would clobber identity/egress/route wiring.
// One exported set so CLI and backend validation agree. See the Cloudflare container deployment rollConfig.
export const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
  'APP',
  'GATEWAY',
  'EGRESS_POLICY',
  'APP_ID',
  'TWO80_ROUTE_POLICY',
  'TWO80_APP_ID',
  'TWO80_SCRIPT',
  'TWO80_APP_HOST_SUFFIX',
  'TWO80_APP_DOMAIN',
  'TWO80_ID_ISSUER',
  'TWO80_ID_SKEW_SECS',
  'TWO80_FRAME_ANCESTORS',
  'TWO80_CONFIG',
]);

export function isReservedBindingName(name: string): boolean {
  return RESERVED_BINDING_NAMES.has(name) || name.startsWith('TWO80_');
}

// A valid environment-variable identifier: a letter or underscore, then letters,
// digits, or underscores. Config keys become container env vars, so they must be
// names a shell and process.env accept.
export const CONFIG_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Container env names the platform's own image and runtime own. Config may not set
// these: PORT/HOSTNAME are baked by the generated Dockerfile and drive gateway
// routing; NODE_ENV/NODE_EXTRA_CA_CERTS drive the build mode and the egress CA. The
// TWO80_ prefix is reserved separately (isReservedConfigName), keeping the platform
// namespace clean.
export const RESERVED_CONFIG_NAMES: ReadonlySet<string> = new Set([
  'PORT',
  'HOSTNAME',
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
]);

export function isReservedConfigName(name: string): boolean {
  return RESERVED_CONFIG_NAMES.has(name) || name.startsWith('TWO80_');
}

// Bounds on a typed credential's scope list, keeping line-based digest records and
// the mint cache key finite.
export const MAX_EGRESS_SCOPES = 50;
export const MAX_EGRESS_SCOPE_BYTES = 4096;

// normalizeScopes trims, drops empties, dedupes, and byte-sorts a scope list so
// scope order and duplicate spelling collapse to one canonical form (one digest,
// one cache key). It never throws; validateEgressPolicy enforces the reject rules.
export function normalizeScopes(scopes: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const s of scopes) {
    const t = s.trim();
    if (t !== '') seen.add(t);
  }
  return [...seen].sort(byteCompare);
}

// Presence-preserving optional string: absent/null both fold to undefined, but an
// explicit '' stays ''. This is what lets validation reject an author-supplied
// transport field on a typed credential — a definite default would erase presence.
const optStr = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? undefined);
const optStrArr = () =>
  z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? undefined);

// EgressCredential binds one allowed host to a platform-held secret the outbound
// handler attaches in-flight. Only the secret NAME travels on the wire; its value
// lives in the Worker vault and never enters the app's container. Fields carry raw
// presence (see optStr): normalizeEgressPolicy applies the type-specific defaults
// (header→authorization/Bearer, google→scopes) so a manifest can be validated for
// author-supplied fields before those defaults are baked in.
export const egressCredentialSchema = z
  .object({
    host: str(),
    secret: str(), // the secret's name; the value is resolved from the vault at call time
    type: optStr(),
    header: optStr(),
    scheme: optStr(),
    scopes: optStrArr(),
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

// normalizeCredential resolves one credential to its deterministic wire form: host
// lowercased/trimmed, type defaulted, and the type-specific transport fields baked.
// A `header` credential keeps its author header/scheme (defaulting to bearer-auth);
// a `google-service-account` credential drops any transport fields to '' and carries
// only normalized scopes. Total and non-throwing, so canonicalDigest can call it on
// any manifest — validateEgressPolicy is the separate gate that rejects bad input.
function normalizeCredential(c: EgressCredential): EgressCredential {
  const host = c.host.trim().toLowerCase();
  const type = credentialType(c);
  if (type === EGRESS_CREDENTIAL_TYPE.GoogleServiceAccount) {
    return { ...c, host, type, header: '', scheme: '', scopes: normalizeScopes(c.scopes ?? []) };
  }
  return {
    ...c,
    host,
    type: EGRESS_CREDENTIAL_TYPE.Header,
    header: c.header ?? 'authorization',
    scheme: c.scheme ?? 'Bearer',
    scopes: [],
  };
}

// normalizeEgressPolicy is the one place the allowlist is derived, so the CLI that
// builds the policy and the runtime that applies it never disagree: a credential's
// host is implicitly allowed, hosts are lowercased/trimmed, duplicates drop, and
// each credential's transport fields are resolved to their canonical form.
export function normalizeEgressPolicy(p: EgressPolicy): EgressPolicy {
  const credentials = p.credentials
    .map(normalizeCredential)
    .filter((c) => c.host !== '');
  const hosts = new Set<string>();
  for (const h of p.allowedHosts) {
    const host = h.trim().toLowerCase();
    if (host !== '') hosts.add(host);
  }
  for (const c of credentials) hosts.add(c.host);
  return { allowedHosts: [...hosts].sort(), credentials };
}

// validateEgressPolicy is the strict semantic gate the fake preflight and the
// backend both run before a deploy changes state. It rejects everything
// normalizeEgressPolicy is deliberately lenient about: unknown types, typed
// credentials on non-provider or wildcard hosts, author-supplied transport fields
// on a typed credential, scopes on a static credential, malformed or missing
// scopes, duplicate credential hosts, and secrets that are undeclared or collide
// with a reserved Worker binding. Throws PreflightRejected; never mints anything.
export function validateEgressPolicy(policy: EgressPolicy, declaredSecrets: readonly string[]): void {
  // A credential's own secret is declared by the credential itself: binding a host
  // to a secret is what makes that secret exist, so it need not be repeated in the
  // top-level "secrets" list (still accepted, for back-compat and non-credential
  // secrets). The reserved-name check below still rejects a colliding secret name.
  const declared = new Set<string>(declaredSecrets);
  for (const c of policy.credentials ?? []) {
    if (c.secret !== '') declared.add(c.secret);
  }
  const seenHosts = new Set<string>();
  for (const c of policy.credentials ?? []) {
    const host = c.host.trim().toLowerCase();
    if (host === '') rejectEgress('an egress credential has an empty host', 'give every egress credential a "host"');
    const type = credentialType(c);
    if (!isEgressCredentialType(type)) {
      rejectEgress(
        `egress credential for ${host} has unknown type ${JSON.stringify(type)}`,
        `set "type" to one of: ${EGRESS_CREDENTIAL_TYPE.Header}, ${EGRESS_CREDENTIAL_TYPE.GoogleServiceAccount}`,
      );
    }
    if (c.secret === '') {
      rejectEgress(`egress credential for ${host} must name a secret`, 'add a "secret" naming a declared secret');
    }
    if (isReservedBindingName(c.secret)) {
      rejectEgress(
        `egress credential secret ${JSON.stringify(c.secret)} is a reserved platform binding name`,
        'rename the secret so it does not collide with a platform Worker binding',
      );
    }
    if (!declared.has(c.secret)) {
      rejectEgress(
        `egress credential for ${host} references secret ${JSON.stringify(c.secret)} which is not declared in secrets`,
        'declare the secret in 280.json "secrets"',
      );
    }
    if (seenHosts.has(host)) {
      rejectEgress(`duplicate egress credential for host ${host}`, 'declare at most one credential per host');
    }
    seenHosts.add(host);

    if (type === EGRESS_CREDENTIAL_TYPE.Header) {
      if (c.scopes !== undefined) {
        rejectEgress(`egress credential for ${host} is type header and must not carry scopes`, 'remove "scopes"');
      }
    } else {
      if (c.header !== undefined || c.scheme !== undefined) {
        rejectEgress(
          `egress credential for ${host} is type ${type} and must not set header or scheme`,
          'remove "header"/"scheme"; the platform mints and attaches the token',
        );
      }
      if (!googleServiceAccountHostAllowed(host)) {
        rejectEgress(
          `egress credential host ${host} is not a valid ${type} host`,
          'use an exact Google API host, e.g. sheets.googleapis.com',
        );
      }
      validateScopesOrThrow(c.scopes, host, type);
    }
  }
}

// validateWireEgressPolicy is validateEgressPolicy for the form that actually
// travels: the CLI ships the NORMALIZED policy (normalizeEgressPolicy has already
// baked each credential's transport fields to their type-specific canonical value —
// header→authorization/Bearer, google→'' plus scopes), but validateEgressPolicy
// reads field *presence* to enforce type/field exclusivity, so it rejects that baked
// form. This restores the presence the normalizer erased, keyed on each credential's
// resolved type, then runs the one strict gate. Every security-relevant value (type,
// host, secret, scopes) survives normalization untouched and is validated exactly as
// on the raw form; only the author-only "did you set header on a typed credential"
// hint is unrecoverable, and that carries no runtime effect (the handler ignores it)
// and is already caught at authoring time in the CLI.
export function validateWireEgressPolicy(policy: EgressPolicy, declaredSecrets: readonly string[]): void {
  const credentials = (policy.credentials ?? []).map((c) => {
    if (credentialType(c) === EGRESS_CREDENTIAL_TYPE.GoogleServiceAccount) {
      const { header: _header, scheme: _scheme, ...rest } = c;
      return rest;
    }
    const { scopes: _scopes, ...rest } = c;
    return rest;
  });
  validateEgressPolicy({ ...policy, credentials }, declaredSecrets);
}

function validateScopesOrThrow(raw: string[] | undefined, host: string, type: string): void {
  for (const s of raw ?? []) {
    const t = s.trim();
    if (t === '') rejectEgress(`egress credential for ${host} has an empty scope`, 'remove blank scope entries');
    if (hasWhitespaceOrControl(t)) {
      rejectEgress(
        `egress credential for ${host} has a scope with whitespace or control characters`,
        'each scope must be a single token with no spaces',
      );
    }
  }
  const norm = normalizeScopes(raw ?? []);
  if (norm.length === 0) {
    rejectEgress(`egress credential for ${host} is type ${type} and requires at least one scope`, 'add a "scopes" list');
  }
  if (norm.length > MAX_EGRESS_SCOPES) {
    rejectEgress(`egress credential for ${host} declares more than ${MAX_EGRESS_SCOPES} scopes`, 'reduce the scope list');
  }
  const bytes = norm.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0);
  if (bytes > MAX_EGRESS_SCOPE_BYTES) {
    rejectEgress(`egress credential for ${host} scopes exceed ${MAX_EGRESS_SCOPE_BYTES} bytes`, 'reduce the scope list');
  }
}

// True if any codepoint is ASCII whitespace or a control character (<= 0x20 or
// 0x7f). A scope carrying one would make the newline-delimited digest record and
// the OAuth space-separated scope string ambiguous.
function hasWhitespaceOrControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

function rejectEgress(message: string, fix: string): never {
  throw new DeployErr({ code: DeployCode.PreflightRejected, message, fix });
}

// ConfigEntry is one non-secret environment variable the app READS at runtime
// (process.env.NAME): URL path segments, resource ids, region, public client ids,
// feature flags. A credential must never enter app config; future SDK capability
// endpoints keep provider credentials backend-side.
// `value` is the committed-public (or committed-sensitive) literal; '' means the
// value is entered in the dashboard. `sensitive` keeps a value out of logs and
// (when value is '') routes entry to the dashboard, parking the deploy until set.
// Sensitivity never promotes config to a secret: the app still reads it.
export const configEntrySchema = z
  .object({
    name: str(),
    value: str(),
    sensitive: bool(),
  })
  .passthrough();
export type ConfigEntry = z.infer<typeof configEntrySchema>;

// publicConfig is the container-env map from every config entry that carries a
// committed value (public or committed-sensitive). Dashboard-entered entries
// (value '') are absent here; the backend reveals and merges them at rollout.
export function publicConfig(config: readonly ConfigEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of config) if (c.value !== '') out[c.name] = c.value;
  return out;
}

// requiredConfigNames are the config entries a human must enter in the dashboard
// before the app can serve: sensitive with no committed value. The deploy parks in
// waiting_secrets until each is present (activator), same gate as required secrets.
export function requiredConfigNames(config: readonly ConfigEntry[]): string[] {
  return config.filter((c) => c.sensitive && c.value === '').map((c) => c.name);
}

// validateConfig is the strict semantic gate for the config block, run by the CLI
// at authoring time and the backend preflight as a backstop. It rejects invalid
// identifiers, duplicates, reserved container/platform names, a name that is also a
// secret (a value is config or secret, never both), and a non-sensitive entry with
// no value (nothing to inject). Throws PreflightRejected.
export function validateConfig(config: readonly ConfigEntry[], declaredSecrets: readonly string[]): void {
  const secrets = new Set(declaredSecrets);
  const seen = new Set<string>();
  for (const c of config) {
    if (!CONFIG_NAME_RE.test(c.name)) {
      rejectConfig(
        `config name ${JSON.stringify(c.name)} is not a valid environment variable name`,
        'use letters, digits, and underscores, starting with a letter or underscore',
      );
    }
    if (isReservedConfigName(c.name)) {
      rejectConfig(
        `config name ${JSON.stringify(c.name)} is reserved by the platform`,
        'rename it; PORT, HOSTNAME, NODE_ENV, NODE_EXTRA_CA_CERTS and the TWO80_ prefix are reserved',
      );
    }
    if (seen.has(c.name)) rejectConfig(`config declares ${JSON.stringify(c.name)} twice`, 'remove the duplicate');
    seen.add(c.name);
    if (secrets.has(c.name)) {
      rejectConfig(
        `${JSON.stringify(c.name)} is declared as both config and a secret`,
        'a value the app reads is config; a credential it never reads is a secret — pick one',
      );
    }
    if (!c.sensitive && c.value === '') {
      rejectConfig(
        `config ${JSON.stringify(c.name)} has no value`,
        'give it a value, or mark it "sensitive" to enter it in the dashboard',
      );
    }
  }
}

function rejectConfig(message: string, fix: string): never {
  throw new DeployErr({ code: DeployCode.PreflightRejected, message, fix });
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
    config: arr(configEntrySchema),
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
  config: ConfigEntry[]; // declared non-secret env vars (names + committed values + sensitive flag)
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
    config: [...(m.config ?? [])],
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
    // The static line is byte-identical to the pre-typed digest: a `header`
    // credential emits only this. Typed credentials add records only on departure
    // from the default — one type line, then one line per scope (never a joined
    // list, since commas are legal in scope URIs) — so static manifests are unchanged.
    const type = credentialType(c);
    h.update(`egress-cred:${c.host}:${c.header}:${c.scheme}:${c.secret}\n`);
    if (type !== EGRESS_CREDENTIAL_TYPE.Header) h.update(`egress-cred-type:${c.host}:${type}\n`);
    for (const scope of c.scopes ?? []) h.update(`egress-cred-scope:${c.host}:${scope}\n`);
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
  // Config (non-secret env the app reads) is part of the trust boundary: editing a
  // committed value must redeploy. Emitted only when present and sorted by name, so a
  // config-less manifest hashes byte-identically to a pre-config one. A dashboard
  // value rides as value '', so entering it in the dashboard does not change the id.
  for (const c of [...(m.config ?? [])].sort((a, b) => byteCompare(a.name, b.name))) {
    h.update(`config:${c.name}:${c.value}:${c.sensitive ? '1' : '0'}\n`);
  }
  return h.digest('hex');
}

// manifestBlobs returns every blob a manifest names. Callers derive Missing from
// it; duplicate digests (identical bytes at different paths) are deduped there.
export function manifestBlobs(m: Manifest): BlobInfo[] {
  return [...m.files];
}
