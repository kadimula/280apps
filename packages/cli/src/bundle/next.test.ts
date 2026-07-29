// Ports cli/internal/bundle/next_test.go plus the frozen cacheKey/collapseSlashes
// vectors. Everything here is hermetic: no adapter, no network. The real-build
// manifest parity lives in manifest-diff.test.ts.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_KIND_BUNDLE,
  MAX_WORKER_GZIP_BYTES,
  digestBytes,
  manifestBlobs,
} from '@280/contracts';
import {
  cacheKey,
  checkEnvelope,
  checkNativeModules,
  collapseSlashes,
  compatibilityDate,
  envelopeError,
  ensureAdapterConfig,
  nextBundle,
  readBundledWorker,
  requireNextBuild,
} from './next.js';
import { PreflightError } from './walk.js';

const vectors = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../contracts/testdata/vectors.json',
    ),
    'utf8',
  ),
) as {
  cacheKey: { rel: string; key: string }[];
  collapseSlashes: { in: string; out: string }[];
};

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), '280-bundle-test-'));
}

// fixtureOutput is a miniature .open-next tree: the shapes the pinned adapter
// emits, with none of its bulk and no adapter run (next_test.go fixtureOutput).
function fixtureOutput(): string {
  const dir = join(tempDir(), '.open-next');
  write(join(dir, 'assets', 'BUILD_ID'), 'bid');
  write(join(dir, 'assets', '_next', 'static', 'chunks', 'app.js'), 'console.log(1)');
  write(join(dir, 'cache', 'bid', 'index.cache'), '{"type":"app"}');
  write(join(dir, 'cache', 'bid', 'blog', 'post.cache'), '{"type":"app"}');
  write(join(dir, 'cache', '__fetch', 'bid', 'abc123'), '{"kind":"FETCH"}');
  return dir;
}

function isPreflight(err: unknown): err is PreflightError {
  return err instanceof PreflightError && err.code === 'preflight_rejected';
}

describe('nextBundle', () => {
  it('shapes the manifest from a finished .open-next tree', () => {
    const dir = fixtureOutput();
    const worker = Buffer.from('export default { fetch() {} }');
    const b = nextBundle(dir, worker);

    expect(b.manifest.kind).toBe(MANIFEST_KIND_BUNDLE);
    expect(b.manifest.worker.digest).toBe(digestBytes(worker));
    // Size is raw bytes, never compressed: that is the seam's contract.
    expect(b.manifest.worker.size).toBe(worker.length);
    expect(b.manifest.worker.path).toBe('');

    const assetPaths = b.manifest.assets.map((a) => a.path).sort();
    expect(assetPaths).toEqual(['/BUILD_ID', '/_next/static/chunks/app.js']);

    expect(b.manifest.cache).toHaveLength(3);
    // Cache entries are keys, not URLs: nothing about them may look servable.
    for (const c of b.manifest.cache) {
      expect(c.path.startsWith('/')).toBe(false);
    }
    // Every blob the manifest names must have content to upload.
    for (const blob of manifestBlobs(b.manifest)) {
      expect(b.content.has(blob.digest)).toBe(true);
    }
  });

  it('accepts a build with no cache directory', () => {
    const dir = join(tempDir(), '.open-next');
    write(join(dir, 'assets', 'index.html'), '<h1>hi</h1>');
    const b = nextBundle(dir, Buffer.from('//'));
    expect(b.manifest.cache).toHaveLength(0);
  });

  it('rejects a build with no assets directory', () => {
    const dir = join(tempDir(), '.open-next');
    write(join(dir, 'worker.js'), '//');
    expect(() => nextBundle(dir, Buffer.from('//'))).toThrow(PreflightError);
  });
});

describe('cacheKey', () => {
  // Pins the derivation against keys computed by the pinned adapter's own
  // computeCacheKey (next_test.go TestCacheKeyGolden).
  const buildID = 'u1NCjZBrwrXRVIqlbVvIR';
  const golden: [string, string][] = [
    [
      buildID + '/index.cache',
      'incremental-cache/' + buildID + '/3f750c643c261e6a46c3c1472f69cf02af572051b67c43ee4fd6309d45001c0e.cache',
    ],
    [
      buildID + '/revalidate.cache',
      'incremental-cache/' + buildID + '/67e4dba291d87d8adcf9bfdfce05426e52eb5269c4cc0bc1e5532a09a53e6eba.cache',
    ],
    [
      buildID + '/_not-found.cache',
      'incremental-cache/' + buildID + '/788bf135b9183609ebaaaee23581117c732cf58ae8996c7a8a18600233a8d6d4.cache',
    ],
    [
      buildID + '/_global-error.cache',
      'incremental-cache/' + buildID + '/3991db4727095fe9728c1323719cb541bc1db88c05af35e47b51527f4de9f09e.cache',
    ],
    [
      buildID + '/static-page.cache',
      'incremental-cache/' + buildID + '/759f941cacb6ae06689dfa4e824e4fb3c4aa0224d3512f546778a8a7f939a3e1.cache',
    ],
    // Fetch entries carry no extension on disk and hash the nested route.
    [
      '__fetch/BID/a/b',
      'incremental-cache/BID/662b7b62a798bb2d53e67cad9778e12e48297c79eae98d3aae7197be825d768f.fetch',
    ],
  ];

  it.each(golden)('golden %s', (rel, want) => {
    expect(cacheKey(rel)).toBe(want);
  });

  it.each(vectors.cacheKey)('frozen vector %#', ({ rel, key }) => {
    expect(cacheKey(rel)).toBe(key);
  });

  it.each(['loose-file', 'bid/index.json', 'index.cache', '__fetch/bid'])(
    'rejects unknown shape %s',
    (rel) => {
      let thrown: unknown;
      try {
        cacheKey(rel);
      } catch (e) {
        thrown = e;
      }
      expect(isPreflight(thrown)).toBe(true);
    },
  );
});

describe('collapseSlashes frozen vectors', () => {
  it.each(vectors.collapseSlashes)('$in -> $out', ({ in: input, out }) => {
    expect(collapseSlashes(input)).toBe(out);
  });
});

describe('checkEnvelope', () => {
  it('accepts a worker exactly at the limit', () => {
    expect(() => envelopeError(MAX_WORKER_GZIP_BYTES * 3, MAX_WORKER_GZIP_BYTES)).not.toThrow();
  });

  it('rejects an oversized worker and names both sizes', () => {
    let thrown: unknown;
    try {
      envelopeError(60 << 20, 12 << 20);
    } catch (e) {
      thrown = e;
    }
    expect(isPreflight(thrown)).toBe(true);
    const msg = (thrown as PreflightError).message;
    for (const want of ['12.0 MiB', '60.0 MiB', '10.0 MiB']) {
      expect(msg).toContain(want);
    }
  });

  it('passes for a small worker', () => {
    expect(() => checkEnvelope(Buffer.from('x'.repeat(1 << 20)))).not.toThrow();
  });
});

describe('checkNativeModules', () => {
  it('rejects a native addon and names the dependency', () => {
    const dir = tempDir();
    write(
      join(dir, 'server-functions', 'default', 'node_modules', 'sharp', 'build', 'sharp.node'),
      '\x7fELF',
    );
    let thrown: unknown;
    try {
      checkNativeModules([dir]);
    } catch (e) {
      thrown = e;
    }
    expect(isPreflight(thrown)).toBe(true);
    expect((thrown as PreflightError).message).toContain('sharp');
  });

  it('names a scoped package', () => {
    const dir = tempDir();
    write(join(dir, 'node_modules', '@img', 'sharp-darwin-arm64', 'lib', 's.node'), '\x7fELF');
    expect(() => checkNativeModules([dir])).toThrow(/@img\/sharp-darwin-arm64/);
  });

  it('passes a clean tree', () => {
    const dir = tempDir();
    write(join(dir, 'worker.js'), '// nothing native here');
    expect(() => checkNativeModules([dir])).not.toThrow();
  });
});

describe('readBundledWorker', () => {
  it('ignores sourcemaps and README', () => {
    const dir = tempDir();
    write(join(dir, 'worker.js'), 'export default {}');
    write(join(dir, 'worker.js.map'), '{}');
    write(join(dir, 'README.md'), 'built output');
    expect(Buffer.from(readBundledWorker(dir)).toString()).toBe('export default {}');
  });

  it('rejects extra modules by name', () => {
    const dir = tempDir();
    write(join(dir, 'worker.js'), 'export default {}');
    write(join(dir, 'a1b2.wasm'), '\x00asm');
    expect(() => readBundledWorker(dir)).toThrow(/a1b2\.wasm/);
  });

  it('adopts the sole non-worker module as the entry', () => {
    const dir = tempDir();
    write(join(dir, 'index.js'), 'export default {}');
    expect(Buffer.from(readBundledWorker(dir)).toString()).toBe('export default {}');
  });

  it('rejects an empty outdir', () => {
    expect(() => readBundledWorker(tempDir())).toThrow(PreflightError);
  });
});

describe('ensureAdapterConfig', () => {
  it('generates both config files when the project has none', () => {
    const root = tempDir();
    write(join(root, 'package.json'), '{"name":"my-app"}');
    const made = ensureAdapterConfig(root);
    expect(made).toHaveLength(2);

    const onConfig = readFileSync(join(root, 'open-next.config.ts'), 'utf8');
    expect(onConfig).toContain('kv-incremental-cache');

    const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    for (const want of [
      '"main": ".open-next/worker.js"',
      '"compatibility_date": "' + compatibilityDate + '"',
      'nodejs_compat',
      'global_fetch_strictly_public',
      '"binding": "ASSETS"',
      '"name": "my-app"',
    ]) {
      expect(wrangler).toContain(want);
    }
    // Bindings are attached server-side at activation; declaring any here would
    // deploy against the developer's own Cloudflare resources.
    for (const forbidden of ['d1_databases', 'kv_namespaces', 'services']) {
      expect(wrangler).not.toContain(forbidden);
    }
  });

  it("leaves the developer's own config alone", () => {
    const root = tempDir();
    write(join(root, 'open-next.config.ts'), '// mine\n');
    write(join(root, 'wrangler.toml'), 'name = "mine"\n');
    const made = ensureAdapterConfig(root);
    expect(made).toHaveLength(0);
    expect(readFileSync(join(root, 'open-next.config.ts'), 'utf8')).toBe('// mine\n');
  });
});

describe('requireNextBuild', () => {
  it('walks a project from no build to a valid standalone build', () => {
    const root = tempDir();
    let thrown: unknown;
    try {
      requireNextBuild(root);
    } catch (e) {
      thrown = e;
    }
    expect(isPreflight(thrown)).toBe(true);
    expect((thrown as PreflightError).fix).toContain('next build');

    write(join(root, '.next', 'BUILD_ID'), 'bid');
    thrown = undefined;
    try {
      requireNextBuild(root);
    } catch (e) {
      thrown = e;
    }
    expect(isPreflight(thrown)).toBe(true);
    expect((thrown as PreflightError).fix).toContain('standalone');

    mkdirSync(join(root, '.next', 'standalone'), { recursive: true });
    expect(() => requireNextBuild(root)).not.toThrow();
  });
});
