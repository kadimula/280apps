// The container buildpack: the generated Next.js context, the escape hatch, the
// secret/dependency exclusions, and the locked CA entrypoint.

import { execFileSync } from 'node:child_process';
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

  it('honors .gitignore: a gitignored secret never uploads and is reported', () => {
    const root = nextProject({
      '.gitignore': 'SUPABASE_SECRETS.md\nsecrets/\n',
      'SUPABASE_SECRETS.md': 'DB_PASSWORD=hunter2',
      'secrets/token.txt': 'ghp_realtoken',
      'README.md': '# demo',
    });
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });

    const b = buildNextContainer(root);
    const p = b.manifest.files.map((f) => f.path);
    expect(p).not.toContain('SUPABASE_SECRETS.md');
    expect(p.some((x) => x.startsWith('secrets/'))).toBe(false);
    expect(p).toContain('README.md'); // a non-ignored file still ships

    const note = b.details.find((n) => n.startsWith('not uploaded (gitignored):'))!;
    expect(note).toContain('SUPABASE_SECRETS.md');
    expect(note).toContain('secrets/');
  });

  it('outside a git checkout, uploads every non-.env file (no gitignore to honor)', () => {
    const root = nextProject({ 'notes.md': 'keep me', 'SUPABASE_SECRETS.md': 'x' });
    const b = buildNextContainer(root); // nextProject is a plain temp dir, not a git repo
    const p = b.manifest.files.map((f) => f.path);
    expect(p).toContain('notes.md');
    expect(p).toContain('SUPABASE_SECRETS.md');
    expect(b.details.some((n) => n.startsWith('not uploaded (gitignored):'))).toBe(false);
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

function textOf(root: string, path: string): string {
  const b = buildNextContainer(root);
  const f = b.manifest.files.find((x) => x.path === path)!;
  return new TextDecoder().decode(b.content.get(f.digest)!);
}

describe('vendoring out-of-tree file: dependencies', () => {
  function workspace(appPkg: Record<string, unknown>, libPkg: Record<string, unknown>) {
    const base = mkdtempSync(join(tmpdir(), '280-ws-'));
    const root = join(base, 'app');
    write(join(root, 'package.json'), JSON.stringify(appPkg));
    write(join(root, 'app', 'page.tsx'), 'export default () => <h1>hi</h1>;');
    write(join(base, 'lib', 'package.json'), JSON.stringify(libPkg));
    write(join(base, 'lib', 'dist', 'index.js'), 'export const x = 1;');
    return { base, root };
  }

  it('copies the target into the context and rewrites package.json + lockfile links', () => {
    const { root } = workspace(
      { name: 'demo', dependencies: { '@acme/lib': 'file:../lib', next: '15.0.0' } },
      { name: '@acme/lib', version: '1.0.0', main: './dist/index.js' },
    );
    write(
      join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'demo',
        lockfileVersion: 3,
        packages: {
          '': { name: 'demo', dependencies: { '@acme/lib': 'file:../lib', next: '15.0.0' } },
          '../lib': { name: '@acme/lib', version: '1.0.0', devDependencies: { tsup: '^8' } },
          'node_modules/@acme/lib': { resolved: '../lib', link: true },
        },
      }),
    );
    const b = buildNextContainer(root);
    const p = b.manifest.files.map((f) => f.path);
    expect(p).toContain('.two80-vendor/acme-lib/package.json');
    expect(p).toContain('.two80-vendor/acme-lib/dist/index.js');

    const pkg = JSON.parse(textOf(root, 'package.json'));
    expect(pkg.dependencies['@acme/lib']).toBe('file:./.two80-vendor/acme-lib');

    const lock = JSON.parse(textOf(root, 'package-lock.json'));
    expect(lock.packages['../lib']).toBeUndefined();
    expect(lock.packages['.two80-vendor/acme-lib'].devDependencies).toBeUndefined();
    expect(lock.packages['node_modules/@acme/lib'].resolved).toBe('.two80-vendor/acme-lib');
    expect(lock.packages[''].dependencies['@acme/lib']).toBe('file:./.two80-vendor/acme-lib');

    expect(b.details.some((n) => n.includes('vendored local dependencies'))).toBe(true);
  });

  it('strips the vendored package build tooling so npm never sees a workspace: dep', () => {
    const { root } = workspace(
      { name: 'demo', dependencies: { '@acme/lib': 'file:../lib', next: '15.0.0' } },
      {
        name: '@acme/lib',
        version: '1.0.0',
        main: './dist/index.js',
        devDependencies: { '@acme/other': 'workspace:*' },
        scripts: { build: 'tsup' },
      },
    );
    const manifest = JSON.parse(textOf(root, '.two80-vendor/acme-lib/package.json'));
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
  });

  it('leaves an in-tree file: dependency untouched (it already ships)', () => {
    const root = nextProject({
      'local/package.json': JSON.stringify({ name: 'local', version: '1.0.0' }),
      'package.json': JSON.stringify({ name: 'demo', dependencies: { local: 'file:./local', next: '15.0.0' } }),
    });
    const b = buildNextContainer(root);
    expect(b.manifest.files.some((f) => f.path.startsWith('.two80-vendor/'))).toBe(false);
    expect(b.notes.some((n) => n.includes('vendored'))).toBe(false);
  });

  it('rejects an out-of-tree file: dep whose target is missing', () => {
    const root = nextProject({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { gone: 'file:../nope', next: '15.0.0' } }),
    });
    expect(() => buildNextContainer(root)).toThrow(/does not exist/);
  });

  it('rejects a vendored package that itself needs another local package', () => {
    const { root } = workspace(
      { name: 'demo', dependencies: { '@acme/lib': 'file:../lib', next: '15.0.0' } },
      { name: '@acme/lib', version: '1.0.0', dependencies: { '@acme/core': 'workspace:*' } },
    );
    expect(() => buildNextContainer(root)).toThrow(/cannot resolve/);
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

describe('280.json outbound policy', () => {
  it('keeps the legacy wire field empty because network policy is platform owned', () => {
    expect(buildNextContainer(nextProject()).manifest.egress).toEqual({ allowedHosts: [], credentials: [] });
  });

  it('rejects the retired egress block before deploy', () => {
    const root = nextProject({
      '280.json': JSON.stringify({ egress: { allow: ['api.stripe.com'] } }),
    });
    expect(() => buildNextContainer(root)).toThrow(/egress.*no longer supported/);
  });

  it('rejects invalid 280.json before deploy', () => {
    const root = nextProject({ '280.json': '{ not json' });
    expect(() => buildNextContainer(root)).toThrow(PreflightError);
  });
});
