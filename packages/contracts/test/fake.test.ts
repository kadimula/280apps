// The fault-injection and atomicity story the fake must honor: the tests conformance
// cannot express, observing serving state directly and driving the fault knobs.

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { Fake } from '../src/deploy/fake.js';
import { asDeployError } from '../src/deploy/error.js';
import {
  APP_STATE_NOT_DEPLOYED,
  MANIFEST_KIND_CONTAINER,
  State,
  digestBytes,
  type BlobInfo,
  type Digest,
  type Identity,
  type Manifest,
} from '../src/index.js';

function bytes(s: string): Uint8Array {
  return Buffer.from(s, 'utf8');
}
function bodyOf(data: Uint8Array): Readable {
  return Readable.from([Buffer.from(data)]);
}

const DOCKERFILE = bytes('FROM node:20-bookworm-slim\nCMD ["node","server.js"]\n');

function mkBundle(server: Uint8Array, files: Record<string, Uint8Array> | null): {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
} {
  const content = new Map<Digest, Uint8Array>();
  const list: BlobInfo[] = [];
  const add = (path: string, data: Uint8Array): void => {
    const d = digestBytes(data);
    content.set(d, data);
    list.push({ path, digest: d, size: data.length });
  };
  add('Dockerfile', DOCKERFILE);
  add('server.js', server);
  for (const [path, data] of Object.entries(files ?? {})) add(path, data);
  return {
    manifest: {
      kind: MANIFEST_KIND_CONTAINER,
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: list,
    },
    content,
  };
}

async function sync(f: Fake, id: Identity, m: Manifest) {
  return f.sync({ identity: id, manifest: m });
}
async function put(f: Fake, appId: string, content: Map<Digest, Uint8Array>, missing: Digest[]) {
  for (const d of missing) {
    const b = content.get(d)!;
    await f.putBlob(appId, d, b.length, bodyOf(b));
  }
}
function id(): Identity {
  return {
    appId: '',
    slug: 'demo',
    framework: 'next',
    gitRemote: 'git@github.com:x/demo.git',
    clientRef: '',
    forceNew: false,
  };
}

describe('Fake fault injection & atomicity', () => {
  it('crash mid-upload then re-run converges to one live app', async () => {
    const f = new Fake();
    const { manifest, content } = mkBundle(bytes('worker bytes'), { 'public/a.js': bytes('asset a') });
    const identity = id();

    const res = await sync(f, identity, manifest);
    f.dropBodyAfter(1); // the connection dies mid-first-blob
    const d = res.missing[0]!;
    let caught: unknown;
    try {
      await f.putBlob(res.app.id, d, content.get(d)!.length, bodyOf(content.get(d)!));
    } catch (e) {
      caught = e;
    }
    const de = asDeployError(caught);
    expect(de?.retryable).toBe(true);

    // The agent re-runs `two80 push`: same identity, same manifest.
    const again = await sync(f, identity, manifest);
    expect(again.deployId).toBe(res.deployId);
    expect(again.app.id).toBe(res.app.id);
    await put(f, again.app.id, content, again.missing);
    expect(f.activeDeployId(again.app.id)).toBe(again.deployId);
    expect(f.appCount()).toBe(1);
  });

  it('transient sync failure is retryable, retry creates no extra app', async () => {
    const f = new Fake();
    const { manifest } = mkBundle(bytes('worker'), null);
    const identity = id();

    f.failNext(1);
    let caught: unknown;
    try {
      await f.sync({ identity, manifest });
    } catch (e) {
      caught = e;
    }
    expect(asDeployError(caught)?.retryable).toBe(true);
    await sync(f, identity, manifest); // the retry succeeds
    expect(f.appCount()).toBe(1);
  });

  it('activation is atomic and a failed activation reopens', async () => {
    const f = new Fake();
    const identity = id();

    const v1 = mkBundle(bytes('worker v1'), null);
    const r1 = await sync(f, identity, v1.manifest);
    await put(f, r1.app.id, v1.content, r1.missing);
    expect(f.activeDeployId(r1.app.id)).toBe(r1.deployId);
    identity.appId = r1.app.id;

    // v2 partially uploaded: v1 must still be serving.
    const v2 = mkBundle(bytes('worker v2'), { 'public/a.js': bytes('a') });
    const r2 = await sync(f, identity, v2.manifest);
    await put(f, r2.app.id, v2.content, r2.missing.slice(0, 1));
    expect(f.activeDeployId(r1.app.id)).toBe(r1.deployId);

    // Activation of v2 fails: deploy is failed, v1 still serving.
    f.failActivation();
    await put(f, r2.app.id, v2.content, r2.missing.slice(1));
    const st = await f.status(r2.app.id, r2.deployId);
    expect(st.state).toBe(State.Failed);
    expect(st.failure?.fix).toBeTruthy();
    expect(f.activeDeployId(r1.app.id)).toBe(r1.deployId);

    // The agent re-runs push: Sync reopens the failed attempt and it goes live.
    const r3 = await sync(f, identity, v2.manifest);
    expect(r3.deployId).toBe(r2.deployId);
    expect(r3.state).toBe(State.Live);
    expect(f.activeDeployId(r1.app.id)).toBe(r2.deployId);
  });

  it('appStatus is not_deployed for an app that never reached a deploy', async () => {
    const f = new Fake();
    const appId = f.seedAppWithoutDeploy('demo');
    const st = await f.appStatus(appId);
    expect(st.state).toBe(APP_STATE_NOT_DEPLOYED);
    expect(st.url).toBe('');
  });
});
