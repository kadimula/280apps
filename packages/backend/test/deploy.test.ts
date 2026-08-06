// In-process behavior of the deploy Service, asserted against the real deploysvc
// so W5's core seam behavior stands on its own before W1 lands.

import { afterEach, describe, expect, it } from 'vitest';
import {
  DeployCode,
  MANIFEST_KIND_CONTAINER,
  MAX_BUILD_CONTEXT_BYTES,
  Resolution,
  State,
  digestBytes,
  type Identity,
  type Manifest,
} from '@280/contracts';
import { DeployErr, bodyOf, bytesOf, newPlatform, portFor, type Harness } from './helpers/harness.js';
import { sanitizeSlug, type Service } from '../src/deploysvc.js';
import { ContainerRuntime, FakeBuilder } from '../src/runtime/container/index.js';

describe('sanitizeSlug', () => {
  it('never returns a name starting with a digit (Cloudflare rejects it at the roll)', () => {
    expect(sanitizeSlug('1-static')).toBe('app-1-static');
    expect(sanitizeSlug('2024-renewals')).toBe('app-2024-renewals');
    expect(sanitizeSlug('My App')).toBe('my-app');
    expect(/^[0-9]/.test(sanitizeSlug('9lives'))).toBe(false);
    expect(sanitizeSlug('###')).toBe('app');
  });
});

// mkBundle builds a container context: the Dockerfile is manifest.files[0]; extra
// source files follow in insertion order.
function mkBundle(
  dockerfileContent: string,
  files: Record<string, string> = {},
): { manifest: Manifest; content: Map<string, Uint8Array> } {
  const content = new Map<string, Uint8Array>();
  const add = (path: string, body: string) => {
    const b = bytesOf(body);
    const d = digestBytes(b);
    content.set(d, b);
    return { path, digest: d, size: b.byteLength };
  };
  const infos = [add('Dockerfile', dockerfileContent)];
  for (const [path, body] of Object.entries(files)) infos.push(add(path, body));
  return {
    manifest: {
      kind: MANIFEST_KIND_CONTAINER,
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: infos,
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

async function fresh(opts: Parameters<typeof newPlatform>[0] = {}): Promise<{ h: Harness; port: Service }> {
  const h = await newPlatform(opts);
  live.push(h);
  const port = await portFor(h);
  return { h, port };
}

describe('sync + activation', () => {
  it('creates on first sync and reports the Dockerfile as missing', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    expect(res.resolution).toBe(Resolution.Created);
    expect(res.state).toBe(State.Uploading);
    expect(res.missing).toEqual([manifest.files[0]!.digest]);
    expect(res.app.url).toContain('280apps.run');
  });

  it('is idempotent on (app, manifest)', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    const a = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    const b = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    expect(b.deployId).toBe(a.deployId);
  });

  it('builds, then parks before rollout until every declared secret is configured', async () => {
    const builder = new FakeBuilder();
    const { h, port } = await fresh({ runtime: new ContainerRuntime(builder) });
    const { manifest, content } = mkBundle('worker');
    manifest.secrets = ['STRIPE_KEY'];
    const res = await port.sync({ identity: ident({ clientRef: 'parked' }), manifest });

    await uploadAll(port, res.app.id, res.missing, content);

    expect((await port.status(res.app.id, res.deployId)).state).toBe(State.WaitingSecrets);
    expect(builder.builds).toHaveLength(1);
    expect(builder.rollouts).toHaveLength(0);

    await h.store.putAppSecret({ appId: res.app.id, name: 'STRIPE_KEY', envelope: '', setBy: 'owner@test', setAt: 1 });
    const app = await h.store.app('usr_test', res.app.id);
    await h.platform.resumeWaitingSecrets(app!);

    expect((await port.status(res.app.id, res.deployId)).state).toBe(State.Live);
    expect(builder.builds).toHaveLength(1);
    expect(builder.rollouts).toHaveLength(1);
  });

  it('re-pushes attach while parked and pass the gate immediately after configuration', async () => {
    const { h, port } = await fresh();
    const { manifest, content } = mkBundle('worker');
    manifest.secrets = ['STRIPE_KEY'];
    const identity = ident({ clientRef: 'reattach' });
    const first = await port.sync({ identity, manifest });
    await uploadAll(port, first.app.id, first.missing, content);

    const parked = await port.sync({ identity, manifest });
    expect(parked.deployId).toBe(first.deployId);
    expect(parked.state).toBe(State.WaitingSecrets);

    await h.store.putAppSecret({ appId: first.app.id, name: 'STRIPE_KEY', envelope: '', setBy: 'owner@test', setAt: 1 });
    const configured = await port.sync({ identity, manifest });
    expect(configured.deployId).toBe(first.deployId);
    expect(configured.state).toBe(State.Live);
  });

  it('goes live when every blob has landed', async () => {
    const { port } = await fresh();
    const { manifest, content } = mkBundle('worker', { 'app/a.txt': 'A' });
    const res = await port.sync({ identity: ident(), manifest });
    await uploadAll(port, res.app.id, res.missing, content);
    const st = await port.status(res.app.id, res.deployId);
    expect(st.state).toBe(State.Live);
    expect(st.url).toContain('280apps.run');
  });

  it('missing shrinks as blobs land', async () => {
    const { port } = await fresh();
    const { manifest, content } = mkBundle('worker', { 'app/a.txt': 'A' });
    const res = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    const workerDigest = manifest.files[0]!.digest;
    await port.putBlob(res.app.id, workerDigest, content.get(workerDigest)!.byteLength, bodyOf(content.get(workerDigest)!));
    const again = await port.sync({ identity: ident({ clientRef: 'r' }), manifest });
    expect(again.missing).toEqual([manifest.files[1]!.digest]);
  });

  it('a redeploy uploads only changed blobs', async () => {
    const { port } = await fresh();
    const first = mkBundle('worker', { 'app/shared.txt': 'S', 'app/a.txt': 'A' });
    const r1 = await port.sync({ identity: ident({ clientRef: 'r' }), manifest: first.manifest });
    await uploadAll(port, r1.app.id, r1.missing, first.content);

    const second = mkBundle('worker', { 'app/shared.txt': 'S', 'app/b.txt': 'B' });
    const r2 = await port.sync({ identity: ident({ clientRef: 'r' }), manifest: second.manifest });
    // shared.txt and the (unchanged) Dockerfile are already present; only b.txt is new.
    expect(r2.missing).toEqual([second.manifest.files[2]!.digest]);
  });
});

describe('push secret notice', () => {
  it('prints nothing when no policy exists and no secrets are declared', async () => {
    const { h, port } = await fresh();
    const { manifest } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });

    expect(await h.store.appPolicy(res.app.id)).toBeNull();
    expect((await port.status(res.app.id, res.deployId)).secretNotice).toBe('');
  });

  it('uses the pending first deploy manifest before a live policy exists', async () => {
    const { h, port } = await fresh({ frontendOrigin: 'https://dashboard.example/' });
    const { manifest } = mkBundle('worker');
    manifest.secrets = ['STRIPE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
    const res = await port.sync({ identity: ident(), manifest });

    expect(await h.store.appPolicy(res.app.id)).toBeNull();
    expect((await port.status(res.app.id, res.deployId)).secretNotice).toBe(
      `declared secrets are not configured: STRIPE_KEY, SUPABASE_SERVICE_ROLE_KEY. Configure them at https://dashboard.example/dashboard/${res.app.id}?variables=1`,
    );
  });

  it('prints nothing when every declared name is configured', async () => {
    const { h, port } = await fresh();
    const { manifest } = mkBundle('worker');
    manifest.secrets = ['STRIPE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
    const res = await port.sync({ identity: ident(), manifest });
    for (const name of manifest.secrets) {
      await h.store.putAppSecret({ appId: res.app.id, name, envelope: '', setBy: 'owner@test', setAt: 1 });
    }

    expect((await port.status(res.app.id, res.deployId)).secretNotice).toBe('');
  });

  it('prints only declared names that are not configured', async () => {
    const { h, port } = await fresh();
    const { manifest, content } = mkBundle('worker');
    manifest.secrets = ['STRIPE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
    const res = await port.sync({ identity: ident(), manifest });
    await h.store.putAppSecret({
      appId: res.app.id,
      name: 'STRIPE_KEY',
      envelope: '',
      setBy: 'owner@test',
      setAt: 1,
    });
    await uploadAll(port, res.app.id, res.missing, content);

    expect((await port.status(res.app.id, res.deployId)).secretNotice).toBe(
      `declared secret is not configured: SUPABASE_SERVICE_ROLE_KEY. Configure it at https://console.280apps.com/dashboard/${res.app.id}?variables=1`,
    );
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
  it('rejects an oversize context', async () => {
    const { port } = await fresh();
    const { manifest } = mkBundle('worker');
    manifest.files[0]!.size = MAX_BUILD_CONTEXT_BYTES + 1;
    await expectCode(() => port.sync({ identity: ident(), manifest }), DeployCode.PreflightRejected);
  });

  it('digest_mismatch stores nothing, then a correct upload recovers', async () => {
    const { port } = await fresh();
    const { manifest, content } = mkBundle('worker');
    const res = await port.sync({ identity: ident(), manifest });
    const digest = manifest.files[0]!.digest;
    await expectCode(
      () => port.putBlob(res.app.id, digest, 5, bodyOf(bytesOf('wrong'))),
      DeployCode.DigestMismatch,
    );
    // the correct bytes still activate
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
