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

  it('still parses the egress block (phase 3 compatibility)', () => {
    const root = projectWith({
      secrets: ['K'],
      egress: { allow: ['api.stripe.com'], credentials: [{ host: 'api.stripe.com', secret: 'K' }] },
    });
    const p = read280(root);
    expect(p.egress.allowedHosts).toContain('api.stripe.com');
    expect(p.egress.credentials[0]?.secret).toBe('K');
  });

  it('parses an untyped credential byte-identically to the pre-typed default', () => {
    const root = projectWith({
      secrets: ['STRIPE_KEY'],
      egress: { credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY' }] },
    });
    expect(read280(root).egress.credentials[0]).toEqual({
      host: 'api.stripe.com',
      secret: 'STRIPE_KEY',
      type: 'header',
      header: 'authorization',
      scheme: 'Bearer',
      scopes: [],
    });
  });

  it('parses a google-service-account credential, normalizing (dedup + byte-sort) its scopes', () => {
    const root = projectWith({
      secrets: ['SHEETS_SA'],
      egress: {
        credentials: [
          {
            host: 'sheets.googleapis.com',
            secret: 'SHEETS_SA',
            type: 'google-service-account',
            scopes: [
              'https://www.googleapis.com/auth/spreadsheets',
              'https://www.googleapis.com/auth/drive.readonly',
              'https://www.googleapis.com/auth/spreadsheets',
            ],
          },
        ],
      },
    });
    expect(read280(root).egress.credentials[0]).toEqual({
      host: 'sheets.googleapis.com',
      secret: 'SHEETS_SA',
      type: 'google-service-account',
      header: '',
      scheme: '',
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    });
  });

  it('rejects an unknown credential type', () => {
    const root = projectWith({
      secrets: ['K'],
      egress: { credentials: [{ host: 'api.example.com', secret: 'K', type: 'oauth2' }] },
    });
    expect(() => read280(root)).toThrow(/unknown type/);
  });

  it('rejects header/scheme on a typed credential', () => {
    const root = projectWith({
      secrets: ['SHEETS_SA'],
      egress: {
        credentials: [
          {
            host: 'sheets.googleapis.com',
            secret: 'SHEETS_SA',
            type: 'google-service-account',
            header: 'authorization',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          },
        ],
      },
    });
    expect(() => read280(root)).toThrow(/must not set header or scheme/);
  });

  it('rejects scopes on a header credential', () => {
    const root = projectWith({
      secrets: ['K'],
      egress: { credentials: [{ host: 'api.example.com', secret: 'K', scopes: ['x'] }] },
    });
    expect(() => read280(root)).toThrow(/must not carry scopes/);
  });

  it('rejects a google-service-account credential with no scopes', () => {
    const root = projectWith({
      secrets: ['SHEETS_SA'],
      egress: {
        credentials: [{ host: 'sheets.googleapis.com', secret: 'SHEETS_SA', type: 'google-service-account' }],
      },
    });
    expect(() => read280(root)).toThrow(/requires at least one scope/);
  });

  it('rejects a typed credential on a host outside the provider suffix', () => {
    const root = projectWith({
      secrets: ['SHEETS_SA'],
      egress: {
        credentials: [
          {
            host: 'evil.example.com',
            secret: 'SHEETS_SA',
            type: 'google-service-account',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          },
        ],
      },
    });
    expect(() => read280(root)).toThrow(/is not a valid google-service-account host/);
  });

  it('rejects a typed credential on a wildcard host', () => {
    const root = projectWith({
      secrets: ['SHEETS_SA'],
      egress: {
        credentials: [
          {
            host: '*.googleapis.com',
            secret: 'SHEETS_SA',
            type: 'google-service-account',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          },
        ],
      },
    });
    expect(() => read280(root)).toThrow(/is not a valid google-service-account host/);
  });

  it('rejects two credentials for the same host', () => {
    const root = projectWith({
      secrets: ['A', 'B'],
      egress: {
        credentials: [
          { host: 'api.example.com', secret: 'A' },
          { host: 'api.example.com', secret: 'B' },
        ],
      },
    });
    expect(() => read280(root)).toThrow(/duplicate egress credential/);
  });

  it('rejects a credential whose secret is not declared in secrets', () => {
    const root = projectWith({
      secrets: ['OTHER'],
      egress: { credentials: [{ host: 'api.example.com', secret: 'MISSING' }] },
    });
    expect(() => read280(root)).toThrow(/not declared in secrets/);
  });

  it('rejects a credential naming a reserved platform binding', () => {
    const root = projectWith({
      secrets: ['GATEWAY'],
      egress: { credentials: [{ host: 'api.example.com', secret: 'GATEWAY' }] },
    });
    expect(() => read280(root)).toThrow(/reserved platform binding/);
  });

  it('rejects a non-string credential type before upload', () => {
    const root = projectWith({
      secrets: ['K'],
      egress: { credentials: [{ host: 'api.example.com', secret: 'K', type: 5 }] },
    });
    expect(() => read280(root)).toThrow(/"type" must be a string/);
  });

  it('rejects a scopes field that is not a list of strings', () => {
    const root = projectWith({
      secrets: ['SHEETS_SA'],
      egress: { credentials: [{ host: 'sheets.googleapis.com', secret: 'SHEETS_SA', scopes: 'nope' }] },
    });
    expect(() => read280(root)).toThrow(/"scopes" must be a list of strings/);
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
