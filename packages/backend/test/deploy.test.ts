// In-process behavior of the deploy Service: the essential cases the shared
// conformance suite (W1) covers, asserted here against the real deploysvc so
// W5's core seam behavior stands on its own before W1 lands. Create/resolve,
// upload-then-live, idempotency, delta redeploy, preflight, digest mismatch,
// invalid blob, status, and delete.

import { afterEach, describe, expect, it } from 'vitest';
import {
  DeployCode,
  MANIFEST_KIND_BUNDLE,
  MAX_WORKER_GZIP_BYTES,
  Resolution,
  State,
  digestBytes,
  type Identity,
  type Manifest,
} from '@280/contracts';
import { DeployErr, bodyOf, bytesOf, newPlatform, portFor, type Harness } from './helpers/harness.js';
import type { Service } from '../src/deploysvc.js';

function mkBundle(
  workerContent: string,
  assets: Record<string, string> = {},
): { manifest: Manifest; content: Map<string, Uint8Array> } {
  const content = new Map<string, Uint8Array>();
  const worker = bytesOf(workerContent);
  const workerDigest = digestBytes(worker);
  content.set(workerDigest, worker);
  const assetInfos = Object.entries(assets).map(([path, body]) => {
    const b = bytesOf(body);
    const d = digestBytes(b);
    content.set(d, b);
    return { path, digest: d, size: b.byteLength };
  });
  return {
    manifest: {
      kind: MANIFEST_KIND_BUNDLE,
      worker: { path: '', digest: workerDigest, size: worker.byteLength },
      assets: assetInfos,
      cache: [],
    },
    content,
  };
}

function ident(over: Partial<Identity> = {}): Identity {
  return { appId: '', slug: 'demo', framework: 'static', gitRemote: '', clientRef: '', forceNew: false, ...over };
}

async function uploadAll(
  port: Service,
  appId: string,
  digests: string[],
  content: Map<string, Uint8Array>,
): Promise<void> {
  for (const d of digests) {
    const bytes = content.get(d)!;
    await port.putBlob(appId, d, bytes.byteLength, bodyOf(bytes));
  }
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<DeployErr> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof DeployErr) {
      expect(err.code).toBe(code);
      return err;
    }
    throw err;
  }
  throw new Error(`expected ${code}, call succeeded`);
}

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

async function fresh(): Promise<{ h: Harness; port: Service }> {
  const h = await newPlatform();
  live.push(h);
  const port = await portFor(h);
  return { h, port };
}

describe('sync + activation', () => {
  it('creates on first sync and reports the worker as missing', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    expect(res.resolution).toBe(Resolution.Created);
    expect(res.state).toBe(State.Uploading);
    expect(res.missing).toEqual([manifest.worker.digest]);
    expect(res.app.url).toContain('280apps.run');
  });

  it('is idempotent on (app, manifest)', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const a = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    const b = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    expect(b.deployId).toBe(a.deployId);
  });

  it('goes live when every blob has landed', async () => {
    const { port } = await fresh();
    const { manifest, content } = mkBundle('worker', { '/a.txt': 'A' });
    const res = await port.sync({ identity: ident(), manifest });
    await uploadAll(port, res.app.id, res.missing, content);
    const st = await port.status(res.app.id, res.deployId);
    expect(st.state).toBe(State.Live);
    expect(st.url).toContain('280apps.run');
  });

  it('missing shrinks as blobs land', async () => {
    const { port } = await fresh();
    const { manifest, content } = mkBundle('worker', { '/a.txt': 'A' });
    const res = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    const workerDigest = manifest.worker.digest;
    await port.putBlob(res.app.id, workerDigest, content.get(workerDigest)!.byteLength, bodyOf(content.get(workerDigest)!));
    const again = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    expect(again.missing).toEqual([manifest.assets[0]!.digest]);
  });

  it('a redeploy uploads only changed blobs', async () => {
    const { port } = await fresh();
    const first = mkBundle('worker', { '/shared.txt': 'S', '/a.txt': 'A' });
    const r1 = await port.sync({ identity: ident({ clientRef: 'r' }), manifest: first.manifest });
    await uploadAll(port, r1.app.id, r1.missing, first.content);

    const second = mkBundle('worker', { '/shared.txt': 'S', '/b.txt': 'B' });
    const r2 = await port.sync({ identity: ident({ clientRef: 'r' }), manifest: second.manifest });
    // shared.txt and the (unchanged) worker are already present; only b.txt is new.
    expect(r2.missing).toEqual([second.manifest.assets[1]!.digest]);
  });
});

describe('resolution', () => {
  it('autolinks a matching fingerprint', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const id = ident({ gitRemote: 'git@github.com:x/demo.git' });
    const a = await port.sync({ identity: id, manifest });
    const b = await port.sync({ identity: id, manifest });
    expect(b.resolution).toBe(Resolution.FingerprintLinked);
    expect(b.app.id).toBe(a.app.id);
  });

  it('reports ambiguous_identity when more than one app matches', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const id = ident({ gitRemote: 'git@github.com:x/demo.git' });
    await port.sync({ identity: id, manifest });
    await port.sync({ identity: { ...id, forceNew: true }, manifest });
    const err = await expectCode(() => port.sync({ identity: id, manifest }), DeployCode.AmbiguousIdentity);
    expect(err.candidates.length).toBe(2);
  });

  it('forceNew always creates a second app', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const a = await port.sync({ identity: ident({ clientRef: 'r', forceNew: true }), manifest });
    const b = await port.sync({ identity: ident({ clientRef: 'r', forceNew: true }), manifest });
    expect(b.app.id).not.toBe(a.app.id);
  });

  it('clientRef dedupes create', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const a = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    const b = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    expect(b.app.id).toBe(a.app.id);
    expect(b.resolution).toBe(Resolution.Existing);
  });

  it('no_such_app for an unknown explicit id', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    await expectCode(() => port.sync({ identity: ident({ appId: 'app_missing' }), manifest }), DeployCode.NoSuchApp);
  });
});

describe('preflight + blobs', () => {
  it('rejects an oversize worker', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    manifest.worker.size = MAX_WORKER_GZIP_BYTES + 1;
    await expectCode(() => port.sync({ identity: ident(), manifest }), DeployCode.PreflightRejected);
  });

  it('digest_mismatch stores nothing, then a correct upload recovers', async () => {
    const { port } = await fresh();
    const { manifest, content } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    const digest = manifest.worker.digest;
    await expectCode(
      () => port.putBlob(res.app.id, digest, 5, bodyOf(bytesOf('wrong'))),
      DeployCode.DigestMismatch,
    );
    // The correct bytes still activate.
    await port.putBlob(res.app.id, digest, content.get(digest)!.byteLength, bodyOf(content.get(digest)!));
    expect((await port.status(res.app.id, res.deployId)).state).toBe(State.Live);
  });

  it('rejects a blob no open deploy names', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    const stray = digestBytes(bytesOf('stray'));
    await expectCode(() => port.putBlob(res.app.id, stray, 5, bodyOf(bytesOf('stray'))), DeployCode.InvalidBlob);
  });

  it('rejects a malformed digest', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    await expectCode(() => port.putBlob(res.app.id, 'not-a-digest', 1, bodyOf(bytesOf('x'))), DeployCode.InvalidBlob);
  });

  it('status of an unknown deploy is not_found', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    await expectCode(() => port.status(res.app.id, 'dep_missing'), DeployCode.NotFound);
  });
});

describe('delete', () => {
  it('dry run changes nothing', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    const dry = await port.delete({ appId: res.app.id, confirm: '' });
    expect(dry.deleted).toBe(false);
    expect(dry.app.slug).toBe(res.app.slug);
    // Still there.
    expect((await port.status(res.app.id, res.deployId)).state).toBeDefined();
  });

  it('rejects a wrong confirmation name', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    await expectCode(
      () => port.delete({ appId: res.app.id, confirm: 'not-the-slug' }),
      DeployCode.ConfirmationRequired,
    );
  });

  it('destroys the app when confirmed by slug', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    const done = await port.delete({ appId: res.app.id, confirm: res.app.slug });
    expect(done.deleted).toBe(true);
    await expectCode(() => port.status(res.app.id, res.deployId), DeployCode.NotFound);
  });
});
