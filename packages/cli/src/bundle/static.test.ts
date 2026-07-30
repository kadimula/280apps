// Static bundle behavior: staticDir resolution order, the empty-build rejection,
// and that a static site becomes a valid container build context (Dockerfile +
// entrypoint + server generated, source files carried at their relative paths).

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_KIND_CONTAINER } from '@280/contracts';
import { buildStatic, staticDir } from './static.js';
import { APP_PORT } from './container.js';
import { PreflightError } from './walk.js';

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), '280-static-test-'));
}

describe('buildStatic', () => {
  it('containerizes a root with index.html, generating the Dockerfile and entrypoint', () => {
    const root = tempDir();
    write(join(root, 'index.html'), '<h1>hi</h1>');
    write(join(root, 'style.css'), 'body{}');

    const b = buildStatic(root);
    expect(b.manifest.kind).toBe(MANIFEST_KIND_CONTAINER);
    expect(b.manifest.build.builder).toBe('static');
    expect(b.manifest.build.dockerfile).toBe('Dockerfile');
    expect(b.manifest.build.port).toBe(APP_PORT);

    const paths = b.manifest.files.map((f) => f.path).sort();
    expect(paths).toContain('index.html');
    expect(paths).toContain('style.css');
    // Platform-generated context files the buildpack injects.
    expect(paths).toContain('Dockerfile');
    expect(paths).toContain('entrypoint.280.sh');
    expect(paths).toContain('server.280.mjs');

    // Every file the manifest names has content to upload, and the Dockerfile
    // names one of them.
    for (const f of b.manifest.files) expect(b.content.has(f.digest)).toBe(true);
    expect(b.manifest.files.some((f) => f.path === b.manifest.build.dockerfile)).toBe(true);
  });

  it('injects the ephemeral-CA entrypoint step into the generated image', () => {
    const root = tempDir();
    write(join(root, 'index.html'), 'x');
    const b = buildStatic(root);
    const entry = b.manifest.files.find((f) => f.path === 'entrypoint.280.sh')!;
    const body = new TextDecoder().decode(b.content.get(entry.digest)!);
    expect(body).toContain('/etc/cloudflare/certs/cloudflare-containers-ca.crt');
    expect(body).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('rejects a directory with no static build', () => {
    const root = tempDir();
    write(join(root, 'package.json'), '{}');
    expect(() => buildStatic(root)).toThrow(PreflightError);
  });
});

describe('staticDir', () => {
  it('prefers root when it has index.html', () => {
    const root = tempDir();
    write(join(root, 'index.html'), 'x');
    write(join(root, 'dist', 'index.html'), 'y');
    expect(staticDir(root)).toBe(root);
  });

  it('resolves conventional build dirs in order dist, build, out, public', () => {
    for (const name of ['dist', 'build', 'out', 'public']) {
      const root = tempDir();
      write(join(root, name, 'index.html'), 'x');
      expect(staticDir(root)).toBe(join(root, name));
    }
  });

  it('prefers dist over a later build dir', () => {
    const root = tempDir();
    write(join(root, 'build', 'index.html'), 'b');
    write(join(root, 'dist', 'index.html'), 'd');
    expect(staticDir(root)).toBe(join(root, 'dist'));
  });

  it('rejects when no build dir has an index.html', () => {
    expect(() => staticDir(tempDir())).toThrow(PreflightError);
  });
});
