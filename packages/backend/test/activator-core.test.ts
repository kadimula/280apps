// ActivatorCore behavior: activation, retry backoff, the stuck-activation
// watchdog, and delete serialization against an in-flight activation. Migrated
// from the AppActivator Durable Object suite (retired with the Workers
// entrypoint): ActivatorCore is storage-agnostic by design, so the same behavior
// is asserted here against a node TaskStorage fake and a controllable clock
// instead of workerd's real DO storage and alarms. The fake models workerd's
// alarm contract: an armed alarm is cleared just before its handler runs, and the
// handler re-arms via setAlarm to retry.

import { beforeEach, describe, expect, it } from 'vitest';
import { DeployCode, MANIFEST_KIND_CONTAINER, State, digestBytes, type Manifest } from '@280/contracts';
import { MemoryBlobStore } from './helpers/memory-blobs.js';
import { InstrumentedStore, TestRuntime } from './helpers/activator-doubles.js';
import { ActivatorCore, type ActivateParams, type TaskStorage } from '../src/activator.js';
import type { App } from '../src/seams.js';

const CLOCK_BASE = 4_000_000_000_000;
const OPTIONS = { stuckMs: 10 * 60 * 1000, attemptCap: 4, backoffBaseMs: 1_000, backoffCapMs: 8_000 };

// A node stand-in for DurableObjectStorage: a keyed map plus a single armed alarm.
class FakeStorage implements TaskStorage {
  private readonly map = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

let store: InstrumentedStore;
let blobs: MemoryBlobStore;
let runtime: TestRuntime;
let clock: number;
let counter = 0;

beforeEach(() => {
  store = new InstrumentedStore();
  blobs = new MemoryBlobStore();
  runtime = new TestRuntime();
  clock = CLOCK_BASE;
});

const ACCOUNT = 'acct_test';

// A per-app executor over its own fake storage, the node counterpart to one
// AppActivator DO instance. depsFactory hands the shared in-memory doubles.
function core(): { core: ActivatorCore; storage: FakeStorage } {
  const storage = new FakeStorage();
  return {
    storage,
    core: new ActivatorCore({
      storage,
      depsFactory: () => ({ store, blobs, runtime }),
      now: () => clock,
      options: OPTIONS,
    }),
  };
}

// creates a fresh app and an uploading deploy whose only blob (the Dockerfile) is
// already stored: enqueue then a stepped alarm reproduces the state settle.
async function seed(content = 'FROM scratch\n'): Promise<{ app: App; deployId: string }> {
  const appId = `app_${counter++}`;
  const worker = new TextEncoder().encode(content);
  const digest = digestBytes(worker);
  const manifest: Manifest = {
    kind: MANIFEST_KIND_CONTAINER,
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest, size: worker.byteLength }],
  };
  const app: App = {
    id: appId,
    accountId: ACCOUNT,
    slug: 'demo',
    framework: 'static',
    url: 'https://demo.280apps.run',
    script: `demo-${appId}`,
    salt: 'salt',
    fingerprint: '',
    clientRef: '',
    storeId: '',
    activeDeploy: '',
  };
  await store.createAccount({ id: ACCOUNT, subject: '' });
  await store.createApp(app);
  const deployId = `dep_${appId}`;
  await store.openDeploy({ appId, id: deployId, manifest, state: State.Uploading, failure: null });
  blobs.set(appId, digest, worker);
  return { app, deployId };
}

function enqueue(c: ActivatorCore, app: App, deployId: string): Promise<void> {
  const params: ActivateParams = { appId: app.id, accountId: ACCOUNT, deployId };
  return c.enqueue(params);
}

// runs one alarm firing the way workerd would: only if an alarm is armed, and
// clearing it before the handler runs (the handler re-arms to retry). Returns
// whether an alarm fired, mirroring runDurableObjectAlarm.
async function step(c: ActivatorCore, storage: FakeStorage): Promise<boolean> {
  if ((await storage.getAlarm()) === null) return false;
  await storage.deleteAlarm();
  await c.onAlarm();
  return true;
}

function scheduledAlarm(storage: FakeStorage): Promise<number | null> {
  return storage.getAlarm();
}

async function state(appId: string, deployId: string): Promise<string | undefined> {
  return (await store.deploy(appId, deployId))?.state;
}

describe('ActivatorCore: activation', () => {
  it('claims and reproduces settle: store id persisted before live', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();

    await enqueue(c, app, deployId);
    // enqueue only persists a task and arms the alarm; claiming is the alarm's
    // job, so the deploy is still uploading and nothing claimed yet
    expect(await state(app.id, deployId)).toBe(State.Uploading);
    expect(store.claimCount()).toBe(0);

    expect(await step(c, storage)).toBe(true);

    expect(await state(app.id, deployId)).toBe(State.Live);
    expect(runtime.activeDeploy(app.id)).toBe(deployId);
    expect(store.claims()).toEqual(['claim:true']);
    expect(store.calls).toEqual(['claim:true', 'setStoreId', 'finishLive']);
    expect((await store.app(ACCOUNT, app.id))?.storeId).toBe(`store_${app.id}`);
    // once live, the task and its alarm are cleared
    expect(await scheduledAlarm(storage)).toBeNull();
    expect(await step(c, storage)).toBe(false);
  });

  it('is idempotent: a re-sync of the same deploy neither re-claims nor resets the task', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();

    await enqueue(c, app, deployId);
    const alarmA = await scheduledAlarm(storage);
    await enqueue(c, app, deployId); // the re-sync
    const alarmB = await scheduledAlarm(storage);
    expect(alarmB).toBe(alarmA); // backoff/schedule undisturbed

    expect(await step(c, storage)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Live);
    expect(store.claimCount()).toBe(1);
  });
});

describe('ActivatorCore: dropped enqueue', () => {
  it('leaves the deploy uploading and a later enqueue recovers it', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();

    // handoff was lost: settle never reached the executor. Nothing is scheduled
    // and the deploy is still uploading, so it cannot wedge in activating.
    expect(await scheduledAlarm(storage)).toBeNull();
    expect(await step(c, storage)).toBe(false);
    expect(await state(app.id, deployId)).toBe(State.Uploading);

    // self-heal: the CLI re-syncs, settle runs again, the executor is asked
    await enqueue(c, app, deployId);
    expect(await step(c, storage)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Live);
  });
});

describe('ActivatorCore: retries', () => {
  it('backs off with a growing delay and never re-claims', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();
    runtime.failNextN(3); // attempts 1..3 fail, attempt 4 succeeds

    await enqueue(c, app, deployId);

    // attempt 1 claims (uploading -> activating), fails, re-arms at base backoff
    expect(await step(c, storage)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Activating);
    expect((await scheduledAlarm(storage))! - clock).toBe(1_000);

    // attempt 2 does not re-claim (already activating) and backs off further
    expect(await step(c, storage)).toBe(true);
    expect((await scheduledAlarm(storage))! - clock).toBe(2_000);

    expect(await step(c, storage)).toBe(true); // attempt 3
    expect((await scheduledAlarm(storage))! - clock).toBe(4_000);

    expect(await step(c, storage)).toBe(true); // attempt 4 succeeds
    expect(await state(app.id, deployId)).toBe(State.Live);

    // the claim ran once across every attempt: retries proceed under it
    expect(store.claimCount()).toBe(1);
  });
});

describe('ActivatorCore: watchdog', () => {
  it('fails a stuck activation retryably and a subsequent push reopens and succeeds', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();
    runtime.failNextN(100); // never succeeds while stuck

    await enqueue(c, app, deployId);
    // burn through the attempt cap (attempts 0..3 run, then attempt reaches 4)
    for (let i = 0; i < OPTIONS.attemptCap; i++) await step(c, storage);
    expect(await state(app.id, deployId)).toBe(State.Activating);

    // next firing is past the cap: the watchdog fails it retryably, clears the task
    expect(await step(c, storage)).toBe(true);
    const dep = await store.deploy(app.id, deployId);
    expect(dep?.state).toBe(State.Failed);
    expect(dep?.failure?.code).toBe(DeployCode.Unavailable);
    expect(dep?.failure?.retryable).toBe(true);
    expect(dep?.failure?.message).toContain('timed out');
    expect(await scheduledAlarm(storage)).toBeNull();

    // a subsequent push: openDeploy reopens the failed deploy, and this time the
    // runtime succeeds
    runtime.failNextN(0);
    await store.openDeploy({ appId: app.id, id: deployId, manifest: dep!.manifest, state: State.Uploading, failure: null });
    expect((await store.deploy(app.id, deployId))?.state).toBe(State.Uploading);
    await enqueue(c, app, deployId);
    expect(await step(c, storage)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Live);
  });

  it('fails a task that has aged past the timeout even before the attempt cap', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();
    runtime.failNextN(100);

    await enqueue(c, app, deployId);
    expect(await step(c, storage)).toBe(true); // attempt 1: claim + fail
    expect(await state(app.id, deployId)).toBe(State.Activating);

    // ten minutes pass; the next firing is over the age limit
    clock += OPTIONS.stuckMs + 1;
    expect(await step(c, storage)).toBe(true);
    expect((await store.deploy(app.id, deployId))?.state).toBe(State.Failed);
    expect(store.claimCount()).toBe(1);
  });
});

describe('ActivatorCore: delete', () => {
  it('supersedes a pending activation: clears the task and a later alarm cannot resurrect it', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();

    // enqueued but not yet run (its alarm is armed)
    await enqueue(c, app, deployId);
    expect(await scheduledAlarm(storage)).not.toBeNull();

    const outcome = await c.runDelete({ app: { ...app }, accountId: ACCOUNT });
    expect(outcome).toEqual({ deleted: true });

    // runtime asked to delete, row gone, pending task and alarm cleared: a stale
    // alarm firing now finds no app and no work
    expect(runtime.deleted).toEqual([app.id]);
    expect(await store.app(ACCOUNT, app.id)).toBeNull();
    expect(await scheduledAlarm(storage)).toBeNull();
    expect(await step(c, storage)).toBe(false);
    expect(runtime.activeDeploy(app.id)).toBe('');
  });

  it('returns a retryable failure as data when the runtime will not release, leaving the row', async () => {
    const { app } = await seed();
    const { core: c } = core();
    runtime.failDeleteWith(new Error('namespace busy'));

    const outcome = await c.runDelete({ app: { ...app }, accountId: ACCOUNT });

    // the failure comes back as data (so its fields survive) and nothing past the
    // runtime step ran: the app row is still there to retry
    expect(outcome).toHaveProperty('error');
    if ('error' in outcome) {
      expect(outcome.error.code).toBe(DeployCode.Unavailable);
      expect(outcome.error.retryable).toBe(true);
    }
    expect(await store.app(ACCOUNT, app.id)).not.toBeNull();
  });

  it('serializes against a mid-flight activation: the runtime activate finishes before the delete', async () => {
    const { app, deployId } = await seed();
    const { core: c, storage } = core();

    // hold the activation inside the runtime
    runtime.openGate();
    await enqueue(c, app, deployId);
    const activating = step(c, storage); // fires the alarm; blocks in runtime.activate
    await new Promise((r) => setTimeout(r, 10)); // let it reach the gated runtime
    expect(runtime.order.at(-1)).toBe(`activate:start:${deployId}`);

    // delete while the activation is mid-flight: it must not touch the runtime
    // until the activation releases
    const deleting = c.runDelete({ app: { ...app }, accountId: ACCOUNT });
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.deleted).toEqual([]); // delete is still waiting

    runtime.releaseGate();
    await activating;
    const outcome = await deleting;

    // the activation completed, then the delete ran: one operation at a time
    expect(outcome).toEqual({ deleted: true });
    expect(runtime.order).toContain(`activate:done:${deployId}`);
    expect(runtime.order.indexOf(`activate:done:${deployId}`)).toBeLessThan(runtime.order.indexOf(`delete:${app.id}`));
    expect(await store.app(ACCOUNT, app.id)).toBeNull();
  });
});
