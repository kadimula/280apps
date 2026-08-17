// The shared enforcement primitives the gateway (enforce), the CLI (diff), and the
// store (register) all depend on. Freezing them here keeps those three consumers in
// agreement about what a route requires.

import { describe, expect, it } from 'vitest';
import {
  APP_ACCESS,
  appPolicyFromManifest,
  appRoleAtLeast,
  canonicalDigest,
  isAppAccess,
  pathMatches,
  resolveRouteGate,
  routeGateSatisfied,
  validateIntegrationRequirements,
  type IntegrationRequirement,
  type Manifest,
  type RouteGate,
} from '../src/types.js';

const gate = (path: string, o: Partial<RouteGate> = {}): RouteGate => ({
  path,
  appRole: o.appRole ?? '',
  role: o.role ?? '',
});

describe('appRoleAtLeast', () => {
  it('ranks owner > admin > editor > viewer', () => {
    expect(appRoleAtLeast('owner', 'viewer')).toBe(true);
    expect(appRoleAtLeast('admin', 'admin')).toBe(true);
    expect(appRoleAtLeast('editor', 'admin')).toBe(false);
    expect(appRoleAtLeast('viewer', 'owner')).toBe(false);
  });
  it('never satisfies from an unknown/empty role (fail closed)', () => {
    expect(appRoleAtLeast('', 'viewer')).toBe(false);
    expect(appRoleAtLeast('superuser', 'viewer')).toBe(false);
  });
});

describe('pathMatches', () => {
  it('matches exact paths and /prefix/* globs (including the bare prefix)', () => {
    expect(pathMatches('/admin/*', '/admin/users')).toBe(true);
    expect(pathMatches('/admin/*', '/admin')).toBe(true);
    expect(pathMatches('/admin/*', '/billing')).toBe(false);
    expect(pathMatches('/', '/')).toBe(true);
  });
});

describe('resolveRouteGate', () => {
  const routes = [gate('/admin/*', { appRole: 'admin' }), gate('/*', { appRole: 'viewer' })];

  it('picks the most specific matching route', () => {
    expect(resolveRouteGate(routes, '/admin/users')).toEqual({ gate: routes[0], declared: true });
    expect(resolveRouteGate(routes, '/dashboard')).toEqual({ gate: routes[1], declared: true });
  });

  it('falls back to owner-only for an undeclared route', () => {
    const r = resolveRouteGate([gate('/admin/*', { appRole: 'admin' })], '/api/export');
    expect(r.declared).toBe(false);
    expect(r.gate.appRole).toBe('owner');
  });
});

describe('routeGateSatisfied', () => {
  it('an owner passes any gate', () => {
    expect(routeGateSatisfied(gate('/x', { role: 'manager' }), { appRole: 'owner', featureRole: '' })).toBe(true);
  });
  it('an app-role gate needs the role floor', () => {
    expect(routeGateSatisfied(gate('/x', { appRole: 'admin' }), { appRole: 'admin', featureRole: '' })).toBe(true);
    expect(routeGateSatisfied(gate('/x', { appRole: 'admin' }), { appRole: 'viewer', featureRole: '' })).toBe(false);
  });
  it('a feature-role gate needs the exact feature role', () => {
    expect(routeGateSatisfied(gate('/x', { role: 'manager' }), { appRole: 'viewer', featureRole: 'manager' })).toBe(true);
    expect(routeGateSatisfied(gate('/x', { role: 'manager' }), { appRole: 'editor', featureRole: '' })).toBe(false);
  });
});

describe('isAppAccess', () => {
  it('accepts the three modes and rejects others (link is retired)', () => {
    expect(isAppAccess(APP_ACCESS.Invited)).toBe(true);
    expect(isAppAccess(APP_ACCESS.AnyoneAtTenant)).toBe(true);
    expect(isAppAccess(APP_ACCESS.Public)).toBe(true);
    expect(isAppAccess('link')).toBe(false);
    expect(isAppAccess('')).toBe(false);
  });
});

function manifest(over: Partial<Manifest>): Manifest {
  return {
    kind: 'container',
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [],
    egress: { allowedHosts: [], credentials: [] },
    access: 'invited',
    roles: [],
    routes: [],
    secrets: [],
    ...over,
  };
}

describe('canonicalDigest folds the policy', () => {
  it('is stable for a default (empty) policy, so old deploy ids do not shift', () => {
    // A manifest with the default access and no policy hashes the same as one with
    // the fields entirely absent (backward compatibility, like egress).
    const withDefaults = canonicalDigest(manifest({}));
    const bare = canonicalDigest({
      kind: 'container',
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: [],
    } as unknown as Manifest);
    expect(withDefaults).toBe(bare);
  });

  it('changes when any enforced section changes', () => {
    const base = canonicalDigest(manifest({}));
    expect(canonicalDigest(manifest({ access: 'public' }))).not.toBe(base);
    expect(canonicalDigest(manifest({ roles: ['manager'] }))).not.toBe(base);
    expect(canonicalDigest(manifest({ routes: [gate('/x', { appRole: 'admin' })] }))).not.toBe(base);
    expect(canonicalDigest(manifest({ secrets: ['K'] }))).not.toBe(base);
    expect(
      canonicalDigest(manifest({ integrations: [{ alias: 'todos', capability: 'google-sheets', operations: ['read'] }] })),
    ).not.toBe(base);
    // A change to the operations a requirement declares also re-derives the id.
    expect(
      canonicalDigest(manifest({ integrations: [{ alias: 'todos', capability: 'google-sheets', operations: ['read', 'append'] }] })),
    ).not.toBe(
      canonicalDigest(manifest({ integrations: [{ alias: 'todos', capability: 'google-sheets', operations: ['read'] }] })),
    );
  });

  it('is order-independent for roles, secrets, and integrations', () => {
    expect(canonicalDigest(manifest({ roles: ['a', 'b'] }))).toBe(canonicalDigest(manifest({ roles: ['b', 'a'] })));
    const a = { alias: 'a', capability: 'google-sheets', operations: ['read'] };
    const b = { alias: 'b', capability: 'google-sheets', operations: ['read'] };
    expect(canonicalDigest(manifest({ integrations: [b, a] }))).toBe(canonicalDigest(manifest({ integrations: [a, b] })));
  });
});

describe('validateIntegrationRequirements', () => {
  const ok = (r: Partial<IntegrationRequirement>): IntegrationRequirement => ({
    alias: 'todos',
    capability: 'google-sheets',
    operations: ['read'],
    ...r,
  });

  it('accepts supported capability + operations', () => {
    expect(() => validateIntegrationRequirements([ok({ operations: ['read', 'append', 'update', 'deleteRows'] })])).not.toThrow();
  });

  it('rejects an unknown capability', () => {
    expect(() => validateIntegrationRequirements([ok({ capability: 'dropbox' })])).toThrow(/unsupported capability/);
  });

  it('rejects an unsupported operation (validated against the catalog)', () => {
    expect(() => validateIntegrationRequirements([ok({ operations: ['read', 'purge'] })])).toThrow(/does not support/);
  });

  it('rejects an empty operations list', () => {
    expect(() => validateIntegrationRequirements([ok({ operations: [] })])).toThrow(/no operations/);
  });

  it('rejects a malformed alias', () => {
    expect(() => validateIntegrationRequirements([ok({ alias: 'has space' })])).toThrow(/alias .* is invalid/);
  });

  it('rejects a duplicate alias', () => {
    expect(() => validateIntegrationRequirements([ok({}), ok({ operations: ['append'] })])).toThrow(/twice/);
  });
});

describe('appPolicyFromManifest', () => {
  it('lifts the enforced sections and normalizes an unknown access mode', () => {
    const p = appPolicyFromManifest(manifest({ access: 'weird' as unknown as Manifest['access'], roles: ['m'] }));
    expect(p.access).toBe('invited');
    expect(p.roles).toEqual(['m']);
  });
});
