// Cloudflare runtime tests. Ported from
// platform/internal/runtime/cloudflare/cloudflare_test.go, extended to assert the
// exact request shapes the runtime sends (plan W6 Done). No real Cloudflare: a
// mock fetch stands in and records every call.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  digestBytes,
  MANIFEST_KIND_BUNDLE,
  type Manifest,
  type Digest,
} from '@280/contracts';
import type { Activation, RuntimeApp } from '../../src/seams.js';
import { Runtime, cfHash, contentType, type Config } from '../../src/runtime/cloudflare/index.js';

// ---- the fake Cloudflare ----

interface RecordedCall {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown; // string (JSON) or FormData (multipart)
}

interface KVPair {
  key: string;
  value: string;
  base64: boolean;
}

// envelope mirrors the Go fake's response shape: success tracks the 2xx status,
// errors is always present, result is the payload.
function envelope(status: number, result: unknown): Response {
  const ok = Math.floor(status / 100) === 2;
  const body = JSON.stringify({
    success: ok,
    errors: [{ code: 10001, message: 'fake' }],
    result: result ?? null,
  });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function headerRecord(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init.headers;
  if (h && typeof h === 'object' && !Array.isArray(h)) {
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

class CFFake {
  calls: RecordedCall[] = [];
  writes: KVPair[][] = [];
  bulkStatus = 0;

  // asset upload session behavior: the buckets Cloudflare claims to still need.
  buckets: string[][] = [];
  // completion token returned by the assets upload endpoint.
  uploadToken = 'completion-jwt';

  // createStore: 'ok' returns a fresh uuid; 'conflict' fails the create so the
  // runtime falls back to adopting the store findStore returns.
  createStoreMode: 'ok' | 'conflict' = 'ok';
  newStoreId = 'store-new';
  adoptStoreId = ''; // findStore returns this (name-matched) when set

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push({
      method,
      path: u.pathname,
      search: u.search,
      headers: headerRecord(init),
      body: init.body,
    });
    const p = u.pathname;

    if (p.endsWith('/assets-upload-session')) {
      return envelope(200, { jwt: 'session-jwt', buckets: this.buckets });
    }
    if (p.endsWith('/workers/assets/upload')) {
      return envelope(200, { jwt: this.uploadToken });
    }
    if (p.endsWith('/bulk')) {
      const pairs = JSON.parse(init.body as string) as KVPair[];
      this.writes.push(pairs);
      return envelope(this.bulkStatus !== 0 ? this.bulkStatus : 200, null);
    }
    if (p.endsWith('/d1/database') && method === 'POST') {
      if (this.createStoreMode === 'conflict') return envelope(409, null);
      return envelope(200, { uuid: this.newStoreId });
    }
    if (p.endsWith('/d1/database') && method === 'GET') {
      const name = new URLSearchParams(u.search).get('name') ?? '';
      const list = this.adoptStoreId ? [{ uuid: this.adoptStoreId, name }] : [];
      return envelope(200, list);
    }
    // script PUT / DELETE, store DELETE, and anything else.
    return envelope(200, null);
  };

  runtime(cfg: Omit<Config, 'fetch'>): Runtime {
    return new Runtime({ ...cfg, fetch: this.fetch });
  }

  // index is the position of the first call with this method whose path ends in
  // suffix, or -1. Mirrors the Go fake's index helper.
  index(method: string, suffix: string): number {
    return this.calls.findIndex((c) => c.method === method && c.path.endsWith(suffix));
  }

  bodyFor(method: string, suffix: string): unknown {
    const c = this.calls.find((x) => x.method === method && x.path.endsWith(suffix));
    return c?.body;
  }

  callFor(method: string, suffix: string): RecordedCall | undefined {
    return this.calls.find((x) => x.method === method && x.path.endsWith(suffix));
  }
}

const baseCfg = {
  accountId: 'acct',
  apiToken: 'tok',
  namespace: 'ns',
  isrCacheKV: 'isr-ns',
};

interface SeedEntry {
  key: string;
  body: string;
}

interface AssetEntry {
  path: string;
  body: string;
}

// activation builds a next.js deploy, with a store already provisioned so
// activation starts at the asset session. Cache seed and assets are optional.
function activation(opts: {
  seed?: SeedEntry[];
  assets?: AssetEntry[];
  framework?: string;
  storeId?: string;
  salt?: string;
}): Activation {
  const worker = new TextEncoder().encode('export default { fetch() {} }');
  const blobs = new Map<Digest, Uint8Array>();
  blobs.set(digestBytes(worker), worker);

  const m: Manifest = {
    kind: MANIFEST_KIND_BUNDLE,
    worker: { path: '', digest: digestBytes(worker), size: worker.length },
    assets: [],
    cache: [],
  };
  for (const e of opts.seed ?? []) {
    const b = new TextEncoder().encode(e.body);
    const d = digestBytes(b);
    blobs.set(d, b);
    m.cache.push({ path: e.key, digest: d, size: b.length });
  }
  for (const a of opts.assets ?? []) {
    const b = new TextEncoder().encode(a.body);
    const d = digestBytes(b);
    blobs.set(d, b);
    m.assets.push({ path: a.path, digest: d, size: b.length });
  }

  const app: RuntimeApp = {
    id: 'app_1',
    slug: 'demo',
    framework: opts.framework ?? 'next',
    script: 'demo-abc',
    salt: opts.salt ?? 'salt',
    storeId: opts.storeId ?? 'store-1',
  };

  return {
    app,
    deployId: 'dep_1',
    manifest: m,
    asset: async (d: Digest): Promise<Uint8Array> => {
      const b = blobs.get(d);
      if (!b) throw new Error('no blob ' + d);
      return b;
    },
  };
}

// ---- content type ----

describe('contentType', () => {
  it('maps the web types a deployed site is made of', () => {
    const cases: [string, string][] = [
      ['/index.html', 'text/html; charset=utf-8'],
      ['/assets/style.css', 'text/css; charset=utf-8'],
      ['/assets/app.js', 'text/javascript; charset=utf-8'],
      ['/_next/static/chunk.mjs', 'text/javascript; charset=utf-8'],
      ['/data.json', 'application/json; charset=utf-8'],
      ['/logo.svg', 'image/svg+xml'],
      ['/photo.JPG', 'image/jpeg'], // extensions are case-insensitive
      ['/font.woff2', 'font/woff2'], // no charset on binary types
      ['/app.js.map', 'application/json; charset=utf-8'],
      ['/app.min.js', 'text/javascript; charset=utf-8'], // only the last extension counts
      ['/README', 'application/octet-stream'], // no extension at all
    ];
    for (const [path, want] of cases) {
      expect(contentType(path), path).toBe(want);
    }
  });

  it('a dotfile lands on the octet-stream fallback', () => {
    expect(contentType('/.env')).toBe('application/octet-stream');
  });
});

// ---- cfHash: the frozen derivation ----

describe('cfHash', () => {
  it('is 32 hex chars of salted sha256 (matches the frozen vectors)', () => {
    // Vectors from packages/contracts/testdata/vectors.json.
    expect(cfHash('', '')).toBe('e7ac0786668e0ff0f02b62bd04f45ff6');
    expect(cfHash('00000000000000000000000000000000', 'aa')).toBe(
      '2b3eb868a0062342629bbc0b23183d84',
    );
    expect(cfHash('deadbeef', '1'.repeat(64))).toBe('1fb0886fc7c8efe9dae21e093102a2de');
    expect(cfHash('salt', 'ff')).toHaveLength(32);
  });
});

// ---- the ISR cache seed ----

describe('seedCache', () => {
  it('writes keys verbatim, base64-flagged, to the configured namespace', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);

    const seed: SeedEntry[] = [
      { key: 'buildid123/index.cache', body: 'prerendered home' },
      { key: 'buildid123/blog/post.cache', body: 'prerendered post' },
      { key: '__meta__buildid123', body: '{}' },
    ];
    await rt.activate(activation({ seed }));

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toHaveLength(seed.length);
    fake.writes[0].forEach((got, i) => {
      expect(got.key, `pair ${i} key`).toBe(seed[i].key);
      expect(got.base64, `pair ${i} base64 flag`).toBe(true);
      const raw = Buffer.from(got.value, 'base64').toString('utf8');
      expect(raw, `pair ${i} value`).toBe(seed[i].body);
    });
    expect(fake.callFor('PUT', '/accounts/acct/storage/kv/namespaces/isr-ns/bulk')).toBeDefined();
  });

  it('seeds before the flip', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);
    await rt.activate(activation({ seed: [{ key: 'b/index.cache', body: 'hi' }] }));

    const bulk = fake.index('PUT', '/bulk');
    const script = fake.index('PUT', '/scripts/demo-abc');
    expect(bulk).toBeGreaterThanOrEqual(0);
    expect(script).toBeGreaterThanOrEqual(0);
    expect(bulk).toBeLessThan(script);
  });

  it('never touches KV when there is nothing to seed', async () => {
    for (const tc of [
      { name: 'empty manifest cache', kv: 'isr-ns', seed: [] as SeedEntry[] },
      { name: 'no namespace configured', kv: '', seed: [{ key: 'b/index.cache', body: 'hi' }] },
    ]) {
      const fake = new CFFake();
      const rt = fake.runtime({ ...baseCfg, isrCacheKV: tc.kv });
      await rt.activate(activation({ seed: tc.seed }));
      expect(fake.writes, tc.name).toHaveLength(0);
      expect(fake.index('PUT', '/scripts/demo-abc'), tc.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('a failed cache write leaves the old version serving (no flip)', async () => {
    const fake = new CFFake();
    fake.bulkStatus = 500;
    const rt = fake.runtime(baseCfg);

    await expect(
      rt.activate(activation({ seed: [{ key: 'b/index.cache', body: 'hi' }] })),
    ).rejects.toThrow(/seed isr cache/);
    expect(fake.index('PUT', '/scripts/demo-abc')).toBe(-1);
  });

  it('chunks a seed larger than one bulk request', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);

    const seed: SeedEntry[] = [];
    for (let i = 0; i <= 1000; i++) {
      seed.push({ key: `b/page-${i}.cache`, body: `body ${i}` });
    }
    await rt.activate(activation({ seed }));

    expect(fake.writes).toHaveLength(2);
    let total = 0;
    for (const w of fake.writes) {
      expect(w.length).toBeLessThanOrEqual(1000);
      total += w.length;
    }
    expect(total).toBe(seed.length);
  });
});

// ---- bindings ----

describe('bindings', () => {
  it('includes the IMAGES binding', () => {
    const rt = new Runtime(baseCfg);
    const images = rt.bindings('store-1').find((b) => b['name'] === 'IMAGES');
    expect(images).toBeDefined();
    expect(images?.['type']).toBe('images');
  });

  it('binds ASSETS, the d1 store, IMAGES, and the ISR KV, and never WORKER_SELF_REFERENCE', () => {
    const rt = new Runtime(baseCfg);
    const bindings = rt.bindings('store-9');
    expect(bindings).toContainEqual({ type: 'assets', name: 'ASSETS' });
    expect(bindings).toContainEqual({ type: 'd1', name: 'store', id: 'store-9' });
    expect(bindings).toContainEqual({
      type: 'kv_namespace',
      name: 'NEXT_INC_CACHE_KV',
      namespace_id: 'isr-ns',
    });
    expect(bindings.some((b) => b['name'] === 'WORKER_SELF_REFERENCE')).toBe(false);
  });

  it('drops the ISR KV binding when no cache namespace is configured', () => {
    const rt = new Runtime({ ...baseCfg, isrCacheKV: '' });
    const names = rt.bindings('store-1').map((b) => b['name']);
    expect(names).not.toContain('NEXT_INC_CACHE_KV');
  });
});

// ---- the script PUT: the atomic flip ----

describe('putScript', () => {
  async function metadataOf(fake: CFFake): Promise<Record<string, unknown>> {
    const call = fake.callFor('PUT', '/scripts/demo-abc');
    expect(call).toBeDefined();
    const form = call!.body as FormData;
    const meta = form.get('metadata') as Blob;
    return JSON.parse(await meta.text()) as Record<string, unknown>;
  }

  it('sends metadata, the worker module, bindings and tags with the account token', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);
    await rt.activate(activation({ seed: [{ key: 'b/index.cache', body: 'hi' }] }));

    const call = fake.callFor('PUT', '/scripts/demo-abc')!;
    expect(call.headers['authorization']).toBe('Bearer tok');
    const form = call.body as FormData;

    const meta = await metadataOf(fake);
    expect(meta['main_module']).toBe('worker.js');
    expect(meta['compatibility_date']).toBe('2026-07-23');
    expect(meta['compatibility_flags']).toEqual(['nodejs_compat', 'global_fetch_strictly_public']);
    expect(meta['tags']).toEqual(['app:app_1', 'deploy:dep_1']);
    // assets JWT threaded through from the (bucketless) upload session.
    expect(meta['assets']).toEqual({
      jwt: 'session-jwt',
      config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' },
    });

    const mod = form.get('worker.js') as File;
    expect(mod).toBeInstanceOf(Blob);
    expect(await mod.text()).toBe('export default { fetch() {} }');
  });

  it('a static app ships the platform worker and SPA not-found handling', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);
    await rt.activate(activation({ framework: 'static' }));

    const call = fake.callFor('PUT', '/scripts/demo-abc')!;
    const form = call.body as FormData;
    const meta = JSON.parse(await (form.get('metadata') as Blob).text()) as Record<string, unknown>;
    expect((meta['assets'] as Record<string, unknown>)['config']).toMatchObject({
      not_found_handling: 'single-page-application',
    });
    const mod = form.get('worker.js') as File;
    expect(await mod.text()).toContain('env.ASSETS.fetch(request)');
  });
});

// ---- assets: salted manifest and base64 bucket upload ----

describe('uploadAssets', () => {
  it('opens the session with a salted path->hash manifest', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);
    const salt = 'pepper';
    await rt.activate(
      activation({ assets: [{ path: '/index.html', body: '<h1>hi</h1>' }], salt, storeId: 'store-1' }),
    );

    const call = fake.callFor('POST', '/assets-upload-session')!;
    const sent = JSON.parse(call.body as string) as {
      manifest: Record<string, { hash: string; size: number }>;
    };
    const digest = digestBytes(new TextEncoder().encode('<h1>hi</h1>'));
    expect(sent.manifest['/index.html']).toEqual({
      hash: cfHash(salt, digest),
      size: '<h1>hi</h1>'.length,
    });
    // the hash is salted, so it is not the bare content digest.
    expect(sent.manifest['/index.html'].hash).not.toBe(digest);
  });

  it('uploads the requested buckets as base64 parts with the session JWT', async () => {
    const fake = new CFFake();
    const salt = 'pepper';
    const digest = digestBytes(new TextEncoder().encode('body-bytes'));
    const hash = cfHash(salt, digest);
    fake.buckets = [[hash]]; // Cloudflare asks for this one hash

    const rt = fake.runtime(baseCfg);
    await rt.activate(
      activation({ assets: [{ path: '/app.js', body: 'body-bytes' }], salt, storeId: 'store-1' }),
    );

    const upload = fake.callFor('POST', '/workers/assets/upload')!;
    expect(upload.headers['authorization']).toBe('Bearer session-jwt');
    expect(upload.search).toBe('?base64=true');

    const form = upload.body as FormData;
    const part = form.get(hash) as File;
    expect(part, 'part keyed by the salted hash').toBeInstanceOf(Blob);
    expect(part.type).toBe(contentType('/app.js'));
    // body is base64 of the raw asset content.
    expect(await part.text()).toBe(Buffer.from('body-bytes').toString('base64'));

    // the completion token from the final bucket flows into the script metadata.
    const script = fake.callFor('PUT', '/scripts/demo-abc')!;
    const metaObj = JSON.parse(
      await ((script.body as FormData).get('metadata') as Blob).text(),
    ) as Record<string, unknown>;
    expect((metaObj['assets'] as Record<string, unknown>)['jwt']).toBe('completion-jwt');
  });
});

// ---- store create / adopt ----

describe('createStore', () => {
  it('creates a D1 store when the app has none and reports the id', async () => {
    const fake = new CFFake();
    fake.newStoreId = 'brand-new-store';
    const rt = fake.runtime(baseCfg);
    const res = await rt.activate(activation({ storeId: '' }));

    expect(res.storeId).toBe('brand-new-store');
    const create = fake.callFor('POST', '/d1/database')!;
    const body = JSON.parse(create.body as string) as { name: string };
    expect(body.name).toBe('store-1'); // "store-" + id without the app_ prefix

    // the created store id is bound into the script.
    const meta = JSON.parse(
      await ((fake.callFor('PUT', '/scripts/demo-abc')!.body as FormData).get('metadata') as Blob).text(),
    ) as { bindings: Record<string, unknown>[] };
    expect(meta.bindings).toContainEqual({ type: 'd1', name: 'store', id: 'brand-new-store' });
  });

  it('passes the primary location hint when configured', async () => {
    const fake = new CFFake();
    const rt = fake.runtime({ ...baseCfg, d1Location: 'weur' });
    await rt.activate(activation({ storeId: '' }));
    const body = JSON.parse(fake.callFor('POST', '/d1/database')!.body as string) as {
      primary_location_hint?: string;
    };
    expect(body.primary_location_hint).toBe('weur');
  });

  it('adopts an existing store when the create conflicts', async () => {
    const fake = new CFFake();
    fake.createStoreMode = 'conflict';
    fake.adoptStoreId = 'left-over-store';
    const rt = fake.runtime(baseCfg);
    const res = await rt.activate(activation({ storeId: '' }));
    expect(res.storeId).toBe('left-over-store');
  });

  it('fails when the create conflicts and no store can be adopted', async () => {
    const fake = new CFFake();
    fake.createStoreMode = 'conflict';
    fake.adoptStoreId = '';
    const rt = fake.runtime(baseCfg);
    await expect(rt.activate(activation({ storeId: '' }))).rejects.toThrow(/create app store/);
  });

  it('skips store creation when the app already has one', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);
    const res = await rt.activate(activation({ storeId: 'store-1' }));
    expect(res.storeId).toBe(''); // unchanged
    expect(fake.index('POST', '/d1/database')).toBe(-1);
  });
});

// ---- delete: script then store, 404 as success ----

describe('delete', () => {
  function app(storeId: string): RuntimeApp {
    return { id: 'app_1', slug: 'demo', framework: 'next', script: 'demo-abc', salt: 'salt', storeId };
  }

  it('deletes the script before the store', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);
    await rt.delete(app('store-1'));

    const script = fake.index('DELETE', '/scripts/demo-abc');
    const store = fake.index('DELETE', '/d1/database/store-1');
    expect(script).toBeGreaterThanOrEqual(0);
    expect(store).toBeGreaterThanOrEqual(0);
    expect(script).toBeLessThan(store);
  });

  it('skips the store delete when the app has none', async () => {
    const fake = new CFFake();
    const rt = fake.runtime(baseCfg);
    await rt.delete(app(''));
    expect(fake.index('DELETE', '/scripts/demo-abc')).toBeGreaterThanOrEqual(0);
    expect(fake.calls.some((c) => c.path.includes('/d1/database'))).toBe(false);
  });

  it('treats a 404 on either delete as success (idempotent)', async () => {
    const fake = new CFFake();
    fake.fetch = async (url: string, init: RequestInit): Promise<Response> => {
      fake.calls.push({
        method: (init.method ?? 'GET').toUpperCase(),
        path: new URL(url).pathname,
        search: new URL(url).search,
        headers: headerRecord(init),
        body: init.body,
      });
      return envelope(404, null);
    };
    const rt = fake.runtime(baseCfg);
    await expect(rt.delete(app('store-1'))).resolves.toBeUndefined();
  });

  it('propagates a non-404 delete failure', async () => {
    const fake = new CFFake();
    fake.fetch = async (url: string, init: RequestInit): Promise<Response> => {
      void init;
      void url;
      return envelope(500, null);
    };
    const rt = fake.runtime(baseCfg);
    await expect(rt.delete(app('store-1'))).rejects.toThrow(/delete worker/);
  });
});

// ---- transport: envelope unwrap and unreachable ----

describe('transport', () => {
  it('surfaces an unreachable Cloudflare as a retryable unavailable error', async () => {
    const rt = new Runtime({
      ...baseCfg,
      fetch: async () => {
        throw new Error('econnrefused');
      },
    });
    await expect(rt.activate(activation({ storeId: 'store-1' }))).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });

  it('treats success:false with a 200 as an API error', async () => {
    const fake = new CFFake();
    fake.fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const u = new URL(url);
      fake.calls.push({
        method: (init.method ?? 'GET').toUpperCase(),
        path: u.pathname,
        search: u.search,
        headers: headerRecord(init),
        body: init.body,
      });
      if (u.pathname.endsWith('/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 10001, message: 'nope' }], result: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return envelope(200, null);
    };
    const rt = fake.runtime(baseCfg);
    await expect(rt.activate(activation({ storeId: 'store-1' }))).rejects.toThrow(/cloudflare: 10001 nope/);
  });
});

// cfHash width sanity against a plain unsalted sha256 (documentation of intent).
it('cfHash is the salted 16-byte prefix, not the full digest', () => {
  const digest = digestBytes(new TextEncoder().encode('x'));
  const full = createHash('sha256').update('salt:' + digest).digest('hex');
  expect(cfHash('salt', digest)).toBe(full.slice(0, 32));
});
