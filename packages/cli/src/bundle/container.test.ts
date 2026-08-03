// The container buildpack: the generated Next.js context, the escape hatch, the
// secret/dependency exclusions, and the locked CA entrypoint.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_KIND_CONTAINER } from '@280/contracts';
import { buildNextContainer, APP_PORT } from './container.js';
import { PreflightError } from './walk.js';

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function nextProject(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), '280-next-test-'));
  write(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { next: '15.0.0' } }));
  write(join(root, 'app', 'page.tsx'), 'export default () => <h1>hi</h1>;');
  for (const [p, body] of Object.entries(extra)) write(join(root, p), body);
  return root;
}

function paths(root: string): string[] {
  return buildNextContainer(root).manifest.files.map((f) => f.path);
}

describe('buildNextContainer', () => {
  it('generates a Dockerfile + entrypoint and carries the source unchanged', () => {
    const root = nextProject();
    const b = buildNextContainer(root);
    expect(b.manifest.kind).toBe(MANIFEST_KIND_CONTAINER);
    expect(b.manifest.build.builder).toBe('next');
    expect(b.manifest.build.dockerfile).toBe('Dockerfile');
    expect(b.manifest.build.port).toBe(APP_PORT);

    const p = b.manifest.files.map((f) => f.path);
    expect(p).toContain('package.json');
    expect(p).toContain('app/page.tsx');
    expect(p).toContain('Dockerfile');
    expect(p).toContain('entrypoint.280.sh');

    const df = b.manifest.files.find((f) => f.path === 'Dockerfile')!;
    const body = new TextDecoder().decode(b.content.get(df.digest)!);
    expect(body).toContain('npm run build'); // builds the app unchanged, no adapter
    expect(body).toContain('280-entrypoint.sh');
    // NODE_ENV=production would drop devDeps; next build needs them (typescript
    // for a next.config.ts, @types). --include=dev keeps the build green.
    expect(body).toContain('npm ci --include=dev');
    expect(body).toContain('npm install --include=dev');
  });

  it('never uploads node_modules, VCS metadata, build output, or secrets', () => {
    const root = nextProject({
      'node_modules/dep/index.js': 'module.exports = 1',
      '.next/BUILD_ID': 'abc',
      '.git/config': '[core]',
      '.env': 'DB_PASSWORD=hunter2',
      '.env.local': 'API_KEY=secret',
    });
    const p = paths(root);
    expect(p.some((x) => x.startsWith('node_modules/'))).toBe(false);
    expect(p.some((x) => x.startsWith('.next/'))).toBe(false);
    expect(p.some((x) => x.startsWith('.git/'))).toBe(false);
    expect(p).not.toContain('.env');
    expect(p).not.toContain('.env.local');
  });

  it('escape hatch: a user Dockerfile wins and nothing is generated', () => {
    const root = nextProject({ Dockerfile: 'FROM node:20\nCMD ["node","server.js"]' });
    const b = buildNextContainer(root);
    expect(b.manifest.build.builder).toBe('dockerfile');
    // The user's Dockerfile is carried; no generated entrypoint is injected.
    const df = b.manifest.files.find((f) => f.path === 'Dockerfile')!;
    expect(new TextDecoder().decode(b.content.get(df.digest)!)).toContain('CMD ["node","server.js"]');
    expect(b.manifest.files.some((f) => f.path === 'entrypoint.280.sh')).toBe(false);
  });

  it('rejects a project with no package.json', () => {
    const root = mkdtempSync(join(tmpdir(), '280-next-test-'));
    write(join(root, 'app', 'page.tsx'), 'x');
    expect(() => buildNextContainer(root)).toThrow(PreflightError);
  });

  it('carries the 280.json policy into the manifest and prints the route → gate diff', () => {
    const root = nextProject({
      'app/admin/page.tsx': 'export default () => null;',
      '280.json': JSON.stringify({
        access: 'invited',
        roles: ['manager'],
        routes: [{ path: '/admin/*', require: { app_role: 'admin' } }],
        secrets: ['SUPABASE_URL'],
      }),
    });
    const b = buildNextContainer(root);
    expect(b.manifest.access).toBe('invited');
    expect(b.manifest.roles).toEqual(['manager']);
    expect(b.manifest.routes).toEqual([{ path: '/admin/*', appRole: 'admin', role: '' }]);
    expect(b.manifest.secrets).toEqual(['SUPABASE_URL']);

    const notes = b.notes.join('\n');
    expect(notes).toContain('route gates');
    expect(notes).toContain('/admin  →  app admin+');
    // The undeclared root page falls through to the fail-closed Owner-only default.
    expect(notes).toContain('/  →  Owner-only (undeclared)');
  });

  it('rejects a malformed 280.json policy before uploading anything', () => {
    const root = nextProject({ '280.json': JSON.stringify({ access: 'everyone' }) });
    expect(() => buildNextContainer(root)).toThrow(PreflightError);
  });
});

describe('buildpack CA-trust (intercepted-HTTPS validates inside the container)', () => {
  function dockerfileOf(root: string): string {
    const b = buildNextContainer(root);
    const df = b.manifest.files.find((f) => f.path === 'Dockerfile')!;
    return new TextDecoder().decode(b.content.get(df.digest)!);
  }
  function entrypointOf(root: string): string {
    const b = buildNextContainer(root);
    const e = b.manifest.files.find((f) => f.path === 'entrypoint.280.sh')!;
    return new TextDecoder().decode(b.content.get(e.digest)!);
  }

  it('the generated Dockerfile installs ca-certificates and runs through the 280 entrypoint', () => {
    const df = dockerfileOf(nextProject());
    expect(df).toContain('ca-certificates');
    expect(df).toContain('ENTRYPOINT ["/280-entrypoint.sh"]');
  });

  it('the entrypoint installs the ephemeral Cloudflare CA and points NODE_EXTRA_CA_CERTS at it', () => {
    const e = entrypointOf(nextProject());
    expect(e).toContain('/etc/cloudflare/certs/cloudflare-containers-ca.crt');
    expect(e).toContain('update-ca-certificates');
    expect(e).toContain('NODE_EXTRA_CA_CERTS');
    expect(e).toContain('exec "$@"'); // then hands off to the app unchanged
  });
});

describe('280.json egress allowlist', () => {
  it('defaults to an empty (default-deny) policy when there is no 280.json', () => {
    const b = buildNextContainer(nextProject());
    expect(b.manifest.egress).toEqual({ allowedHosts: [], credentials: [] });
  });

  it('lifts allow + credentials into the manifest and folds credential hosts into the allowlist', () => {
    const root = nextProject({
      '280.json': JSON.stringify({
        name: 'demo',
        egress: {
          allow: ['data.example.com'],
          credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY' }],
        },
      }),
    });
    const b = buildNextContainer(root);
    expect(b.manifest.egress.allowedHosts).toEqual(['api.stripe.com', 'data.example.com']);
    expect(b.manifest.egress.credentials[0]).toMatchObject({
      host: 'api.stripe.com',
      secret: 'STRIPE_KEY',
      header: 'authorization',
      scheme: 'Bearer',
    });
    // The allowlist is surfaced to the author in the push notes.
    expect(b.notes.some((n) => n.includes('egress allowlist') && n.includes('api.stripe.com'))).toBe(true);
  });

  it('a 280.json without an egress block stays default-deny', () => {
    const root = nextProject({ '280.json': JSON.stringify({ name: 'demo', features: [] }) });
    expect(buildNextContainer(root).manifest.egress.allowedHosts).toEqual([]);
  });

  it('rejects a malformed egress block at preflight', () => {
    const root = nextProject({
      '280.json': JSON.stringify({ egress: { allow: [{ not: 'a string' }] } }),
    });
    expect(() => buildNextContainer(root)).toThrow(PreflightError);
  });

  it('rejects invalid 280.json before deploy', () => {
    const root = nextProject({ '280.json': '{ not json' });
    expect(() => buildNextContainer(root)).toThrow(PreflightError);
  });
});
