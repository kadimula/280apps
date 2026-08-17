import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_ACCESS,
  APP_ROLE_ORDER,
  asDeployError,
  describeGate,
  isAppAccess,
  resolveRouteGate,
  validateConfig,
  validateIntegrationRequirements,
  type ConfigEntry,
  type EgressPolicy,
  type IntegrationRequirement,
  type RouteGate,
} from '@280/contracts';
import { fail, fileExists } from './walk.js';
export interface Policy280 {
  egress: EgressPolicy;
  access: string;
  roles: string[];
  routes: RouteGate[];
  secrets: string[];
  config: ConfigEntry[];
  integrations: IntegrationRequirement[];
}
const EMPTY: Policy280 = {
  egress: { allowedHosts: [], credentials: [] },
  access: APP_ACCESS.Invited,
  roles: [],
  routes: [],
  secrets: [],
  config: [],
  integrations: [],
};
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
  if (o.egress !== undefined && o.egress !== null) {
    fail(
      '280.json "egress" is no longer supported',
      'remove "egress" and use @two80/sdk; deployed apps can only reach the 280 API',
    );
  }
  const roles = parseRoles(o.roles);
  const secrets = parseSecrets(o.secrets);
  return {
    egress: { allowedHosts: [], credentials: [] },
    access: parseAccess(o.access),
    roles,
    routes: parseRoutes(o.routes, roles),
    secrets,
    config: parseConfig(o.config, secrets),
    integrations: parseIntegrations(o.integrations),
  };
}
const INTEGRATIONS_EXAMPLE =
  'e.g. "integrations": { "todos": { "capability": "google-sheets", "operations": ["read", "append"] } }';
function parseIntegrations(v: unknown): IntegrationRequirement[] {
  if (v === undefined || v === null) return [];
  if (typeof v !== 'object' || Array.isArray(v)) {
    fail('280.json "integrations" must be an object mapping an alias to its capability', INTEGRATIONS_EXAMPLE);
  }
  const reqs = Object.entries(v as Record<string, unknown>).map(([alias, raw]) => parseIntegrationEntry(alias, raw));
  reqs.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  try {
    validateIntegrationRequirements(reqs);
  } catch (err) {
    const d = asDeployError(err);
    if (d) fail(d.message, d.fix, d.code);
    throw err;
  }
  return reqs;
}
function parseIntegrationEntry(alias: string, raw: unknown): IntegrationRequirement {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`280.json integration "${alias}" must be an object`, INTEGRATIONS_EXAMPLE);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.capability !== 'string' || o.capability === '') {
    fail(`280.json integration "${alias}" needs a "capability"`, INTEGRATIONS_EXAMPLE);
  }
  if (!Array.isArray(o.operations) || o.operations.some((op) => typeof op !== 'string')) {
    fail(`280.json integration "${alias}" needs an "operations" list`, INTEGRATIONS_EXAMPLE);
  }
  return { alias, capability: o.capability, operations: [...(o.operations as string[])] };
}
function parseConfig(v: unknown, secrets: string[]): ConfigEntry[] {
  if (v === undefined || v === null) return [];
  if (typeof v !== 'object' || Array.isArray(v)) {
    fail('280.json "config" must be an object mapping NAME to a value', 'e.g. "config": { "REGION": "us-east-1" }');
  }
  const entries = Object.entries(v as Record<string, unknown>).map(([name, raw]) => parseConfigEntry(name, raw));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  try {
    validateConfig(entries, secrets);
  } catch (err) {
    const d = asDeployError(err);
    if (d) fail(d.message, d.fix, d.code);
    throw err;
  }
  return entries;
}
function parseConfigEntry(name: string, raw: unknown): ConfigEntry {
  if (typeof raw === 'string') return { name, value: raw, sensitive: false };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(
      `280.json config "${name}" must be a string or an object`,
      'e.g. "REGION": "us-east-1", or "SHEET_ID": { "sensitive": true }',
    );
  }
  const o = raw as Record<string, unknown>;
  let value = '';
  if (o.value !== undefined && o.value !== null) {
    if (typeof o.value !== 'string') fail(`280.json config "${name}" value must be a string`, 'quote the value');
    value = o.value;
  }
  let sensitive = false;
  if (o.sensitive !== undefined && o.sensitive !== null) {
    if (typeof o.sensitive !== 'boolean') fail(`280.json config "${name}" sensitive must be true or false`, 'use a boolean');
    sensitive = o.sensitive;
  }
  return { name, value, sensitive };
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
