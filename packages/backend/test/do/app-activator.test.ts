// AppActivator Durable Object behavior, exercised inside workerd (real DO storage
// and alarms) via @cloudflare/vitest-pool-workers. The object's per-execution deps
// are overridden with in-memory doubles (store, blobs, runtime) and a logical
// clock, so these assert control-plane behavior without a database or the
// Cloudflare API:
//
//   - the same transitions the old inline settle produced (the store id persisted
//     before the outcome; live; failed);
//   - the claim (uploading -> activating) happens INSIDE the object, not the
//     request;
//   - a dropped enqueue leaves the deploy uploading and a re-sync recovers it;
//   - alarm retries back off and proceed under the existing claim;
//   - the watchdog fails a stuck activation and a subsequent push succeeds;
//   - a delete supersedes a mid-flight or pending activation.
//
// The logical clock is seeded far in the future so armed alarms never auto-fire;
// each execution is stepped deterministically with runDurableObjectAlarm, and the
// watchdog's clock is advanced by hand.

import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeployCode, MANIFEST_KIND_BUNDLE, State, digestBytes, type Manifest } from '@280/contracts';
import { MemoryBlobStore } from '../helpers/memory-blobs.js';
import { InstrumentedStore, TestRuntime } from '../helpers/activator-doubles.js';
import { AppActivator, __setActivatorTestConfig } from '../../src/app-activator.js';
import type { App } from '../../src/seams.js';

// A far-future base so setAlarm(now()) is never due against real wall-clock: alarms
// only run when the test steps them.
const CLOCK_BASE = 4_000_000_000_000;
const OPTIONS = { stuckMs: 10 * 60 * 1000, attemptCap: 4, backoffBaseMs: 1_000, backoffCapMs: 8_000 };

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
  __setActivatorTestConfig({
    depsFactory: () => ({ store, blobs, runtime }),
    options: OPTIONS,
    now: () => clock,
  });
});

const ACCOUNT = 'acct_test';

// seed creates a fresh app and an uploading deploy whose only blob (the worker) is
// already stored — the state settle hands the object. Each call uses a unique app
// id, so every case runs against its own Durable Object instance and storage.
async function seed(content = 'worker'): Promise<{ app: App; deployId: string }> {
  const appId = `app_${counter++}`;
  const worker = new TextEncoder().encode(content);
  const digest = digestBytes(worker);
  const manifest: Manifest = {
    kind: MANIFEST_KIND_BUNDLE,
    worker: { path: '', digest, size: worker.byteLength },
    assets: [],
    cache: [],
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

type Stub = ReturnType<typeof stubFor>;

function stubFor(appId: string) {
  return env.APP_ACTIVATOR.get(env.APP_ACTIVATOR.idFromName(appId));
}

function enqueue(stub: Stub, app: App, deployId: string): Promise<void> {
  return runInDurableObject(stub, (obj) =>
    (obj as AppActivator).activate({ appId: app.id, accountId: ACCOUNT, deployId }),
  );
}

// step runs one execution (one alarm firing), returning whether an alarm was
// scheduled to run.
function step(stub: Stub): Promise<boolean> {
  return runDurableObjectAlarm(stub);
}

function scheduledAlarm(stub: Stub): Promise<number | null> {
  return runInDurableObject(stub, (_obj, state) => state.storage.getAlarm());
}

async function state(appId: string, deployId: string): Promise<string | undefined> {
  return (await store.deploy(appId, deployId))?.state;
}

describe('AppActivator: activation', () => {
  it('claims inside the object and reproduces settle: store id persisted before live', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);

    await enqueue(stub, app, deployId);
    // The enqueue only persists a task and arms the alarm; the claim is the
    // object's job, so the deploy is still uploading and the request never claimed.
    expect(await state(app.id, deployId)).toBe(State.Uploading);
    expect(store.claimCount()).toBe(0);

    expect(await step(stub)).toBe(true);

    expect(await state(app.id, deployId)).toBe(State.Live);
    expect(runtime.activeDeploy(app.id)).toBe(deployId);
    // The claim happened inside the object, exactly once, before the runtime ran;
    // the store id was persisted before the deploy was marked live.
    expect(store.claims()).toEqual(['claim:true']);
    expect(store.calls).toEqual(['claim:true', 'setStoreId', 'finishLive']);
    expect((await store.app(ACCOUNT, app.id))?.storeId).toBe(`store_${app.id}`);
    // Once live, the task and its alarm are cleared.
    expect(await scheduledAlarm(stub)).toBeNull();
    expect(await step(stub)).toBe(false);
  });

  it('is idempotent: a re-sync of the same deploy neither re-claims nor resets the task', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);

    await enqueue(stub, app, deployId);
    const alarmA = await scheduledAlarm(stub);
    await enqueue(stub, app, deployId); // the re-sync
    const alarmB = await scheduledAlarm(stub);
    expect(alarmB).toBe(alarmA); // backoff/schedule undisturbed

    expect(await step(stub)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Live);
    expect(store.claimCount()).toBe(1);
  });
});

describe('AppActivator: dropped enqueue', () => {
  it('leaves the deploy uploading and a later enqueue recovers it', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);

    // The handoff was lost: settle never reached the object. Nothing is scheduled
    // and the deploy is still uploading — it cannot wedge in activating.
    expect(await scheduledAlarm(stub)).toBeNull();
    expect(await step(stub)).toBe(false);
    expect(await state(app.id, deployId)).toBe(State.Uploading);

    // The self-heal: the CLI re-syncs, settle runs again, the object is asked.
    await enqueue(stub, app, deployId);
    expect(await step(stub)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Live);
  });
});

describe('AppActivator: retries', () => {
  it('backs off with a growing delay and never re-claims', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);
    runtime.failNextN(3); // attempts 1..3 fail, attempt 4 succeeds

    await enqueue(stub, app, deployId);

    // Attempt 1 claims (uploading -> activating), fails, and re-arms with the base
    // backoff.
    expect(await step(stub)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Activating);
    expect((await scheduledAlarm(stub))! - clock).toBe(1_000);

    // Attempt 2 does not re-claim (the deploy is already activating) and backs off
    // further.
    expect(await step(stub)).toBe(true);
    expect((await scheduledAlarm(stub))! - clock).toBe(2_000);

    // Attempt 3.
    expect(await step(stub)).toBe(true);
    expect((await scheduledAlarm(stub))! - clock).toBe(4_000);

    // Attempt 4 succeeds.
    expect(await step(stub)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Live);

    // The claim ran once across every attempt: retries proceed under it.
    expect(store.claimCount()).toBe(1);
  });
});

describe('AppActivator: watchdog', () => {
  it('fails a stuck activation retryably and a subsequent push reopens and succeeds', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);
    runtime.failNextN(100); // never succeeds while stuck

    await enqueue(stub, app, deployId);
    // Burn through the attempt cap (attempts 0..3 run, then attempt reaches 4).
    for (let i = 0; i < OPTIONS.attemptCap; i++) await step(stub);
    expect(await state(app.id, deployId)).toBe(State.Activating);

    // The next firing is past the attempt cap: the watchdog fails it retryably and
    // clears the task.
    expect(await step(stub)).toBe(true);
    const dep = await store.deploy(app.id, deployId);
    expect(dep?.state).toBe(State.Failed);
    expect(dep?.failure?.code).toBe(DeployCode.Unavailable);
    expect(dep?.failure?.retryable).toBe(true);
    expect(dep?.failure?.message).toContain('timed out');
    expect(await scheduledAlarm(stub)).toBeNull();

    // A subsequent push: openDeploy reopens the failed deploy, and this time the
    // runtime succeeds.
    runtime.failNextN(0);
    await store.openDeploy({ appId: app.id, id: deployId, manifest: dep!.manifest, state: State.Uploading, failure: null });
    expect((await store.deploy(app.id, deployId))?.state).toBe(State.Uploading);
    await enqueue(stub, app, deployId);
    expect(await step(stub)).toBe(true);
    expect(await state(app.id, deployId)).toBe(State.Live);
  });

  it('fails a task that has aged past the timeout even before the attempt cap', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);
    runtime.failNextN(100);

    await enqueue(stub, app, deployId);
    expect(await step(stub)).toBe(true); // attempt 1: claim + fail
    expect(await state(app.id, deployId)).toBe(State.Activating);

    // Ten minutes pass; the next firing is over the age limit.
    clock += OPTIONS.stuckMs + 1;
    expect(await step(stub)).toBe(true);
    expect((await store.deploy(app.id, deployId))?.state).toBe(State.Failed);
    expect(store.claimCount()).toBe(1);
  });
});

describe('AppActivator: delete', () => {
  it('supersedes a pending activation: clears the task and a later alarm cannot resurrect it', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);

    // An activation is enqueued but not yet run (its alarm is armed).
    await enqueue(stub, app, deployId);
    expect(await scheduledAlarm(stub)).not.toBeNull();

    const outcome = await runInDurableObject(stub, (obj) =>
      (obj as AppActivator).delete({ app: { ...app }, accountId: ACCOUNT }),
    );
    expect(outcome).toEqual({ deleted: true });

    // The runtime was asked to delete, the row is gone, and the pending task and
    // its alarm are cleared — a stale alarm firing now finds no app and no work.
    expect(runtime.deleted).toEqual([app.id]);
    expect(await store.app(ACCOUNT, app.id)).toBeNull();
    expect(await scheduledAlarm(stub)).toBeNull();
    expect(await step(stub)).toBe(false);
    expect(runtime.activeDeploy(app.id)).toBe('');
  });

  it('returns a retryable failure as data when the runtime will not release, leaving the row', async () => {
    const { app } = await seed();
    const stub = stubFor(app.id);
    runtime.failDeleteWith(new Error('namespace busy'));

    const outcome = await runInDurableObject(stub, (obj) =>
      (obj as AppActivator).delete({ app: { ...app }, accountId: ACCOUNT }),
    );

    // The failure comes back as data (so its fields survive the RPC boundary), and
    // nothing past the runtime step ran: the app row is still there to retry.
    expect(outcome).toHaveProperty('error');
    if ('error' in outcome) {
      expect(outcome.error.code).toBe(DeployCode.Unavailable);
      expect(outcome.error.retryable).toBe(true);
    }
    expect(await store.app(ACCOUNT, app.id)).not.toBeNull();
  });

  it('serializes against a mid-flight activation: the runtime activate finishes before the delete', async () => {
    const { app, deployId } = await seed();
    const stub = stubFor(app.id);

    // Hold the activation inside the runtime.
    runtime.openGate();
    await enqueue(stub, app, deployId);
    const activating = step(stub); // fires the alarm; blocks in runtime.activate
    // Let the execution reach the gated runtime.
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.order.at(-1)).toBe(`activate:start:${deployId}`);

    // Ask to delete while the activation is mid-flight. It must not touch the
    // runtime until the activation releases.
    const deleting = runInDurableObject(stub, (obj) =>
      (obj as AppActivator).delete({ app: { ...app }, accountId: ACCOUNT }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.deleted).toEqual([]); // delete is still waiting

    runtime.releaseGate();
    await activating;
    const outcome = await deleting;

    // The activation completed, then the delete ran — one operation at a time.
    expect(outcome).toEqual({ deleted: true });
    expect(runtime.order).toContain(`activate:done:${deployId}`);
    expect(runtime.order.indexOf(`activate:done:${deployId}`)).toBeLessThan(runtime.order.indexOf(`delete:${app.id}`));
    expect(await store.app(ACCOUNT, app.id)).toBeNull();
  });
});
