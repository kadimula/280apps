// Ported from platform/conformance_test.go: the tenancy, activation-recovery,
// revert, and blob-scoping claims the shared conformance suite (W1) cannot make,
// since it only exercises one already-authenticated user. Run against the
// deploy Service (in-process) and the HTTP router.

import { afterEach, describe, expect, it } from 'vitest';
import { DeployCode, DeployErr, MANIFEST_KIND_CONTAINER, State, digestBytes, type SyncResult } from '@280/contracts';
import { HttpClient, bodyOf, newPlatform, newServer, portFor, seedToken, testManifest, type Harness } from './helpers/harness.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});
async function platform(): Promise<Harness> {
  const h = await newPlatform();
  live.push(h);
  return h;
}
async function server(
  cfg: Parameters<typeof newServer>[0],
): Promise<{ app: Awaited<ReturnType<typeof newServer>>['app']; harness: Harness }> {
  const s = await newServer(cfg);
  live.push(s.harness);
  return { app: s.app, harness: s.harness };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ${code}, call succeeded`);
  } catch (err) {
    if (!(err instanceof DeployErr)) throw err;
    expect(err.code).toBe(code);
  }
}

describe('UsersAreIsolated', () => {
  it('scopes autolink, addressing, and delete by user', async () => {
    const { app, harness } = await server({});
    await seedToken(harness, 'usr_alice', 'alice-token');
    await seedToken(harness, 'usr_bob', 'bob-token');
    const { manifest } = testManifest();
    const id = { slug: 'demo', framework: 'static', gitRemote: 'git@github.com:x/demo.git' };

    const alice = new HttpClient(app, 'alice-token');
    const res = await alice.sync({ identity: id as never, manifest });

    // same identity, different token: Bob must not autolink onto Alice's app
    const bob = new HttpClient(app, 'bob-token');
    const bobRes = await bob.sync({ identity: id as never, manifest });
    expect(bobRes.app.id).not.toBe(res.app.id);
    expect(bobRes.resolution).toBe('created');

    await expectCode(
      () => bob.sync({ identity: { ...id, appId: res.app.id } as never, manifest }),
      DeployCode.NoSuchApp,
    );

    // Bob knows Alice's id and slug, everything delete asks for, yet is refused
    await expectCode(() => bob.delete(res.app.id, res.app.slug), DeployCode.NoSuchApp);

    const st = await alice.status(res.app.id, res.deployId);
    expect(st.state).toBeDefined();
  });
});

describe('ActivationFailureReopens', () => {
  it('a failed deploy is attempt-terminal, and re-push recovers', async () => {
    const h = await platform();
    const port = await portFor(h);
    const { manifest, worker, digest } = testManifest();
    const req = {
      identity: { appId: '', slug: 'demo', framework: 'static', gitRemote: '', clientRef: 'ref-1', forceNew: false },
      manifest,
    };

    h.builder.failNext(
      new DeployErr({
        code: DeployCode.Unavailable,
        message: 'activation failed on the platform',
        fix: 'run two80 push again',
      }),
    );

    const res = await port.sync(req);
    await port.putBlob(res.app.id, digest, worker.byteLength, bodyOf(worker));

    const st = await port.status(res.app.id, res.deployId);
    expect(st.state).toBe(State.Failed);
    expect(st.failure).toBeDefined();
    expect(h.builder.activeDeploy(res.app.id)).toBe('');

    // push again: same call, same manifest, no client-side recovery
    const again = await port.sync(req);
    expect(again.deployId).toBe(res.deployId);
    expect(again.state).toBe(State.Live);
    expect(h.builder.activeDeploy(res.app.id)).toBe(res.deployId);
  });
});

describe('RevertRepushReactivates', () => {
  it('re-pushing once-live content re-points the runtime', async () => {
    const h = await platform();
    const port = await portFor(h);

    const push = async (content: string): Promise<SyncResult> => {
      const { manifest, worker, digest } = testManifest(content);
      const res = await port.sync({
        identity: { appId: '', slug: 'demo', framework: 'static', gitRemote: '', clientRef: 'ref-1', forceNew: false },
        manifest,
      });
      for (const d of res.missing) {
        expect(d).toBe(digest);
        await port.putBlob(res.app.id, d, worker.byteLength, bodyOf(worker));
      }
      return res;
    };

    const v1 = await push('worker v1');
    const v2 = await push('worker v2');
    expect(v2.deployId).not.toBe(v1.deployId);
    expect(h.builder.activeDeploy(v1.app.id)).toBe(v2.deployId);

    const back = await push('worker v1');
    expect(back.deployId).toBe(v1.deployId);
    expect(h.builder.activeDeploy(v1.app.id)).toBe(v1.deployId);
  });
});

describe('BlobsAreAppScoped', () => {
  it('a blob uploaded for one app does not satisfy another', async () => {
    const h = await platform();
    const port = await portFor(h);
    const content = 'identical bytes in both apps';
    const digest = digestBytes(new TextEncoder().encode(content));

    const one = testManifest(content);
    const first = await port.sync({
      identity: { appId: '', slug: 'one', framework: 'static', gitRemote: '', clientRef: 'one', forceNew: false },
      manifest: one.manifest,
    });
    await port.putBlob(first.app.id, digest, one.worker.byteLength, bodyOf(one.worker));

    const two = testManifest(content);
    const second = await port.sync({
      identity: { appId: '', slug: 'two', framework: 'static', gitRemote: '', clientRef: 'two', forceNew: false },
      manifest: two.manifest,
    });
    expect(second.missing).toEqual([digest]);
  });
});

describe('Unauthorized', () => {
  it('an unknown token fails unauthorized with a fix', async () => {
    const { app } = await server({});
    const client = new HttpClient(app, 'not-a-real-token');
    try {
      await client.sync({
        identity: { slug: 'demo', framework: 'static' } as never,
        manifest: { kind: MANIFEST_KIND_CONTAINER, build: { builder: '', dockerfile: '', port: 0 }, files: [] },
      });
      throw new Error('expected unauthorized');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployErr);
      const de = err as DeployErr;
      expect(de.code).toBe(DeployCode.Unauthorized);
      expect(de.fix).not.toBe('');
    }
  });
});

describe('host suffix (staging URLs)', () => {
  it('appends a first-level suffix to the app host label', async () => {
    const h = await newPlatform({ hostSuffix: '-staging' });
    live.push(h);
    const port = await portFor(h);
    const res = await port.sync({
      identity: { appId: '', slug: 'demo', framework: 'static', gitRemote: '', clientRef: '', forceNew: false },
      manifest: testManifest().manifest,
    });
    expect(res.app.url).toMatch(/^https:\/\/demo-[0-9a-z]{10}-staging\.280apps\.run$/);
  });
});
