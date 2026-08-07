// Parsing 280.json into the platform-enforced policy the Manifest carries, plus
// the route→gate diff the deploy prints. The whole file is the app's trust
// boundary (design §5.1): `access` decides who may open the app, `roles` names the
// feature roles, `routes` gates paths, `secrets` declares credential names, and
// `egress` (phase 3) is the outbound allowlist. A malformed 280.json fails here,
// before any upload, so the builder fixes it in the same session.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_ACCESS,
  APP_ROLE_ORDER,
  asDeployError,
  describeGate,
  isAppAccess,
  normalizeEgressPolicy,
  resolveRouteGate,
  validateEgressPolicy,
  type EgressCredential,
  type EgressPolicy,
  type RouteGate,
} from '@280/contracts';
import { fail, fileExists } from './walk.js';

export interface Policy280 {
  egress: EgressPolicy;
  access: string;
  roles: string[];
  routes: RouteGate[];
  secrets: string[];
}

const EMPTY: Policy280 = {
  egress: { allowedHosts: [], credentials: [] },
  access: APP_ACCESS.Invited,
  roles: [],
  routes: [],
  secrets: [],
};

// read280 parses the whole 280.json into the enforced policy. Absent file =>
// default-deny egress and the invited default with no roles or gates. Every
// malformed section fails preflight with an agent-actionable fix.
export function read280(root: string): Policy280 {
  const path = join(root, '280.json');
  if (!fileExists(path)) return { ...EMPTY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('280.json is not valid JSON', 'fix the JSON syntax in 280.json, then run two80 push again');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('280.json must be a JSON object', 'wrap your settings in { ... }');
  }
  const o = parsed as Record<string, unknown>;
  const roles = parseRoles(o.roles);
  const secrets = parseSecrets(o.secrets);
  return {
    egress: parseEgress(o.egress, secrets),
    access: parseAccess(o.access),
    roles,
    routes: parseRoutes(o.routes, roles),
    secrets,
  };
}

function parseAccess(v: unknown): string {
  if (v === undefined || v === null || v === '') return APP_ACCESS.Invited;
  if (typeof v !== 'string' || !isAppAccess(v)) {
    fail('280.json "access" must be one of invited, anyone-at-tenant, public', 'e.g. "access": "invited"');
  }
  return v;
}

function parseRoles(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((r) => typeof r !== 'string' || r === '')) {
    fail('280.json "roles" must be a list of non-empty role names', 'e.g. "roles": ["manager", "analyst"]');
  }
  const seen = new Set<string>();
  for (const r of v as string[]) {
    if (seen.has(r)) fail(`280.json declares role "${r}" twice`, 'remove the duplicate role');
    seen.add(r);
  }
  return [...(v as string[])];
}

function parseSecrets(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s === '')) {
    fail('280.json "secrets" must be a list of secret names', 'e.g. "secrets": ["SUPABASE_URL", "BOX_TOKEN"]');
  }
  const seen = new Set<string>();
  for (const s of v as string[]) {
    if (seen.has(s)) fail(`280.json declares secret "${s}" twice`, 'remove the duplicate secret name');
    seen.add(s);
  }
  return [...(v as string[])];
}

// parseRoutes normalizes the human `{ path, require: { app_role | role } }` shape
// into the flat RouteGate the wire carries, validating each requirement so a typo
// (an unknown app role, a role the app never declared, or both/neither set) is
// caught before deploy, not silently gated to owner-only at runtime.
function parseRoutes(v: unknown, roles: string[]): RouteGate[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    fail('280.json "routes" must be a list of route rules', 'e.g. "routes": [{ "path": "/admin/*", "require": { "app_role": "admin" } }]');
  }
  const known = new Set(roles);
  return (v as unknown[]).map((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      fail(`280.json routes[${i}] must be an object`, 'e.g. { "path": "/admin/*", "require": { "app_role": "admin" } }');
    }
    const r = raw as { path?: unknown; require?: unknown };
    if (typeof r.path !== 'string' || r.path === '') {
      fail(`280.json routes[${i}] needs a non-empty "path"`, 'e.g. "path": "/admin/*"');
    }
    if (r.require === null || typeof r.require !== 'object') {
      fail(`280.json routes[${i}] needs a "require"`, 'e.g. "require": { "app_role": "admin" } or { "role": "manager" }');
    }
    const req = r.require as { app_role?: unknown; role?: unknown };
    const appRole = typeof req.app_role === 'string' ? req.app_role : '';
    const role = typeof req.role === 'string' ? req.role : '';
    if (appRole === '' && role === '') {
      fail(`280.json routes[${i}] ("${r.path}") requires nothing`, 'set an "app_role" (owner|admin|editor|viewer) or a "role"');
    }
    if (appRole !== '' && role !== '') {
      fail(`280.json routes[${i}] ("${r.path}") sets both app_role and role`, 'pick one requirement per route');
    }
    if (appRole !== '' && !(APP_ROLE_ORDER as readonly string[]).includes(appRole)) {
      fail(`280.json routes[${i}] app_role "${appRole}" is unknown`, `use one of ${APP_ROLE_ORDER.join(', ')}`);
    }
    if (role !== '' && !known.has(role)) {
      fail(`280.json routes[${i}] requires role "${role}", not in "roles"`, `add "${role}" to "roles", or fix the name`);
    }
    return { path: r.path, appRole, role };
  });
}

// parseEgress reads the app's outbound contract. Author-supplied fields keep their
// raw presence (an absent transport field is left unset, not defaulted) so the
// contract's validateEgressPolicy can reject a typed credential that carries a
// header/scheme, or a static one that carries scopes, before any default is baked.
// The whole policy is validated against the declared secrets here — the same gate
// the backend runs — so a bad credential fails before openPort and before upload.
function parseEgress(v: unknown, secrets: string[]): EgressPolicy {
  if (v === undefined || v === null) return { allowedHosts: [], credentials: [] };
  if (typeof v !== 'object') {
    fail('280.json "egress" must be an object', 'set "egress": { "allow": [...], "credentials": [...] }');
  }
  const e = v as { allow?: unknown; allowedHosts?: unknown; credentials?: unknown };
  const allow = e.allow ?? e.allowedHosts ?? [];
  if (!Array.isArray(allow) || allow.some((h) => typeof h !== 'string')) {
    fail('280.json egress.allow must be a list of host strings', 'e.g. "allow": ["api.stripe.com", "*.supabase.co"]');
  }
  const rawCreds = e.credentials ?? [];
  if (!Array.isArray(rawCreds)) {
    fail('280.json egress.credentials must be a list', 'e.g. "credentials": [{ "host": "api.stripe.com", "secret": "STRIPE_KEY" }]');
  }
  const credentials = rawCreds.map(parseCredential);
  const policy: EgressPolicy = { allowedHosts: allow as string[], credentials };
  validateEgressOrFail(policy, secrets);
  return normalizeEgressPolicy(policy);
}

// parseCredential shape-checks one raw credential and carries every author-supplied
// field through with its presence intact (absent stays absent). Only structural
// typos are caught here; the semantic rules (type vocabulary, provider host
// boundary, scope-on-header, reserved/undeclared secret) are validateEgressPolicy's.
function parseCredential(c: unknown, i: number): EgressCredential {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    fail(`280.json egress.credentials[${i}] must be an object`, 'e.g. { "host": "api.stripe.com", "secret": "STRIPE_KEY" }');
  }
  const raw = c as Record<string, unknown>;
  if (typeof raw.host !== 'string' || raw.host === '') {
    fail(`280.json egress.credentials[${i}] needs a "host"`, 'e.g. { "host": "api.stripe.com", "secret": "STRIPE_KEY" }');
  }
  if (typeof raw.secret !== 'string' || raw.secret === '') {
    fail(`280.json egress.credentials[${i}] needs a "secret" name`, 'name a secret you declared in 280.json "secrets"');
  }
  const cred: EgressCredential = { host: raw.host, secret: raw.secret };
  for (const field of ['type', 'header', 'scheme'] as const) {
    if (raw[field] === undefined || raw[field] === null) continue;
    if (typeof raw[field] !== 'string') {
      fail(`280.json egress.credentials[${i}] "${field}" must be a string`, `remove or fix "${field}" on the ${raw.host} credential`);
    }
    cred[field] = raw[field] as string;
  }
  if (raw.scopes !== undefined && raw.scopes !== null) {
    if (!Array.isArray(raw.scopes) || raw.scopes.some((s) => typeof s !== 'string')) {
      fail(`280.json egress.credentials[${i}] "scopes" must be a list of strings`, 'e.g. "scopes": ["https://www.googleapis.com/auth/spreadsheets.readonly"]');
    }
    cred.scopes = raw.scopes as string[];
  }
  return cred;
}

// validateEgressOrFail runs the contract's single semantic gate and re-raises its
// rejection as the CLI's PreflightError, so a typed-egress mistake reads like any
// other preflight failure (code, message, fix) instead of leaking a foreign error.
function validateEgressOrFail(policy: EgressPolicy, secrets: string[]): void {
  try {
    validateEgressPolicy(policy, secrets);
  } catch (err) {
    const d = asDeployError(err);
    if (d) fail(d.message, d.fix, d.code);
    throw err;
  }
}

// routeGateDiff renders what each of the app's routes will require after deploy,
// resolving the app's own route files against the declared gates. The whole point
// (design §07) is that an undeclared route shows as Owner-only so the builder sees
// the fail-closed default and fixes the manifest before teammates hit a wall.
export function routeGateDiff(discovered: string[], declared: RouteGate[]): string[] {
  if (discovered.length === 0) {
    if (declared.length === 0) return [];
    return ['route gates (no app routes detected; showing declared rules):', ...declaredLines(declared)];
  }
  const lines: string[] = ['route gates (every route must map to a gate; undeclared = Owner-only):'];
  let undeclared = 0;
  for (const path of discovered) {
    const { gate, declared: isDeclared } = resolveRouteGate(declared, path);
    if (!isDeclared) undeclared++;
    lines.push(`  ${path}  →  ${describeGate(gate, isDeclared)}${isDeclared ? '' : '  ⚠'}`);
  }
  if (declared.length === 0) {
    return [
      'no route gates declared: every invited viewer can reach the whole app.',
      'to gate routes, add a "routes" list to 280.json (design §07).',
    ];
  }
  if (undeclared > 0) {
    lines.push(`  ${undeclared} route(s) fall through to Owner-only; declare them in 280.json to open them up.`);
  }
  return lines;
}

function declaredLines(declared: RouteGate[]): string[] {
  return declared.map((g) => `  ${g.path}  →  ${describeGate(g, true)}`);
}
