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
});
