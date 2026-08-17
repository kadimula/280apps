import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { read280, routeGateDiff } from './manifest280.js';
import { PreflightError } from './walk.js';

function projectWith(json: unknown): string {
  const root = mkdtempSync(join(tmpdir(), '280-manifest-test-'));
  writeFileSync(join(root, '280.json'), JSON.stringify(json));
  return root;
}

describe('read280', () => {
  it('parses access, roles, routes (normalizing require), and secrets', () => {
    const root = projectWith({
      name: 'renewals',
      access: 'invited',
      roles: ['manager', 'analyst'],
      routes: [
        { path: '/admin/*', require: { app_role: 'admin' } },
        { path: '/api/approve', require: { role: 'manager' } },
      ],
      secrets: ['SUPABASE_URL'],
    });
    const p = read280(root);
    expect(p.access).toBe('invited');
    expect(p.roles).toEqual(['manager', 'analyst']);
    expect(p.secrets).toEqual(['SUPABASE_URL']);
    expect(p.routes).toEqual([
      { path: '/admin/*', appRole: 'admin', role: '' },
      { path: '/api/approve', appRole: '', role: 'manager' },
    ]);
  });

  it('defaults to invited with no policy when 280.json is absent', () => {
    const root = mkdtempSync(join(tmpdir(), '280-empty-'));
    const p = read280(root);
    expect(p.access).toBe('invited');
    expect(p.roles).toEqual([]);
    expect(p.routes).toEqual([]);
  });

  it('accepts the public access mode', () => {
    expect(read280(projectWith({ access: 'public' })).access).toBe('public');
  });

  it('rejects an unknown access mode (the retired link value included)', () => {
    expect(() => read280(projectWith({ access: 'link' }))).toThrow(PreflightError);
  });

  it('rejects a route requiring an undeclared feature role', () => {
    const root = projectWith({ roles: ['manager'], routes: [{ path: '/x', require: { role: 'ghost' } }] });
    expect(() => read280(root)).toThrow(/not in "roles"/);
  });

  it('rejects a route with both app_role and role', () => {
    const root = projectWith({
      roles: ['manager'],
      routes: [{ path: '/x', require: { app_role: 'admin', role: 'manager' } }],
    });
    expect(() => read280(root)).toThrow(/both/);
  });

  it('rejects a route with an unknown app_role', () => {
    expect(() => read280(projectWith({ routes: [{ path: '/x', require: { app_role: 'root' } }] }))).toThrow(
      PreflightError,
    );
  });

  it('rejects a route with no requirement', () => {
    expect(() => read280(projectWith({ routes: [{ path: '/x', require: {} }] }))).toThrow(PreflightError);
  });

  it('rejects a duplicate role', () => {
    expect(() => read280(projectWith({ roles: ['a', 'a'] }))).toThrow(/twice/);
  });

  it('rejects a duplicate secret name', () => {
    expect(() => read280(projectWith({ secrets: ['STRIPE_KEY', 'STRIPE_KEY'] }))).toThrow(/twice/);
  });

  it('rejects the retired egress block', () => {
    expect(() => read280(projectWith({ egress: { allow: ['api.stripe.com'] } }))).toThrow(
      /egress.*no longer supported/,
    );
  });

  it('parses supported integrations', () => {
    expect(read280(projectWith({ integrations: ['google-sheets'] })).integrations).toEqual(['google-sheets']);
  });

  it('rejects malformed, unknown, and duplicate integrations', () => {
    expect(() => read280(projectWith({ integrations: 'google-sheets' }))).toThrow(/must be a list/);
    expect(() => read280(projectWith({ integrations: ['google-sheet'] }))).toThrow(/not supported/);
    expect(() => read280(projectWith({ integrations: ['google-sheets', 'google-sheets'] }))).toThrow(/twice/);
  });
});

describe('read280 config', () => {
  it('parses the three config forms, name-sorted', () => {
    const p = read280(
      projectWith({
        config: {
          REGION: 'us-east-1',
          COMMITTED_SECRET: { value: 'v', sensitive: true },
          SHEET_ID: { sensitive: true },
        },
      }),
    );
    expect(p.config).toEqual([
      { name: 'COMMITTED_SECRET', value: 'v', sensitive: true },
      { name: 'REGION', value: 'us-east-1', sensitive: false },
      { name: 'SHEET_ID', value: '', sensitive: true },
    ]);
  });

  it('rejects a name that is both config and a secret', () => {
    const root = projectWith({ secrets: ['SHARED'], config: { SHARED: 'x' } });
    expect(() => read280(root)).toThrow(/both config and a secret/);
  });

  it('rejects a reserved config name', () => {
    expect(() => read280(projectWith({ config: { PORT: '9000' } }))).toThrow(/reserved/);
  });

  it('rejects a non-sensitive config entry with no value', () => {
    expect(() => read280(projectWith({ config: { EMPTY: { sensitive: false } } }))).toThrow(/has no value/);
  });

  it('rejects config that is not an object', () => {
    expect(() => read280(projectWith({ config: ['REGION'] }))).toThrow(/must be an object/);
  });
});

describe('routeGateDiff', () => {
  const declared = [
    { path: '/admin/*', appRole: 'admin', role: '' },
    { path: '/*', appRole: 'viewer', role: '' },
  ];

  it('flags an undeclared route as Owner-only', () => {
    const lines = routeGateDiff(['/', '/admin/users', '/api/export'], declared);
    const joined = lines.join('\n');
    expect(joined).toContain('/admin/users  →  app admin+');
    expect(joined).toContain('/  →  app viewer+');
    // /api/export matches the /* viewer catch-all here (declared), so it is not
    // owner-only — prove the fail-closed default with a policy that has no catch-all.
    const strict = routeGateDiff(['/api/export'], [{ path: '/admin/*', appRole: 'admin', role: '' }]);
    expect(strict.join('\n')).toContain('Owner-only (undeclared)');
  });

  it('says the app is fully open when no routes are declared', () => {
    const lines = routeGateDiff(['/', '/dashboard'], []);
    expect(lines.join('\n')).toContain('every invited viewer can reach the whole app');
  });

  it('returns nothing when there is neither a route nor a gate to show', () => {
    expect(routeGateDiff([], [])).toEqual([]);
  });
});
