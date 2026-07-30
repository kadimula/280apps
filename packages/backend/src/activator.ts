// The activation seam: the per-app executor that turns a content-complete deploy
// into the app's serving version, and the destructive tail of a delete.
//
// This is the cross-isolate replacement for deploysvc's old in-isolate
// withAppLock. Two implementations of the Activator port serialize a single
// app's activation and delete against each other:
//
//   - DurableObjectActivator hands the work to the app's AppActivator Durable
//     Object (src/app-activator.ts), keyed per app via idFromName. That object is
//     the single global instance per app, and everything it does runs through one
//     promise chain (ActivatorCore), so a given app activates or deletes one
//     operation at a time across every isolate. This is what production uses.
//
//   - InProcessActivator runs activation inline and synchronously, exactly as the
//     old settle did (claim, run the runtime, persist the store id, finish
//     live/failed on the single attempt). The tests and the conformance suite
//     drive the Service directly and expect a deploy to be live the instant its
//     last blob lands, which this preserves; there is no Durable Object in a node
//     test.
//
// ActivatorCore is the durable executor the Durable Object delegates to. It is
// deliberately storage-agnostic (it takes a TaskStorage, which the real
// DurableObjectStorage and a node fake both satisfy) so the same executor runs
// under Miniflare and under a plain node test with a controllable clock.

import {
  DeployCode,
  DeployErr,
  State,
  stateTerminal,
  type Digest,
  type DeployError,
} from '@280/contracts';
import type { App, BlobStore, Deploy, Runtime, RuntimeApp, Store } from './seams.js';
import type { Logger } from './observe.js';
import { asDeployErr, deployShaped, errText, internal } from './deploysvc.js';

// Activator serializes one app's activation and delete. settle enqueues an
// activation once a deploy's content is complete; Service.delete runs the
// destructive tail through delete(). Both are serialized per app by the
// implementation.
export interface Activator {
  // activate makes deployId the app's serving version. It must be durable and
  // return promptly — before the activation completes — so the request that
  // landed the last blob is not held open for the runtime round trip. The claim
  // (uploading -> activating) happens inside the activation, never in the caller.
  activate(app: App, deployId: string): Promise<void>;

  // delete runs the destructive tail — runtime, then blobs, then the row, in that
  // order — serialized against any activation of the same app, and reports
  // whether a row was removed. Dry-run and confirmation stay in the caller.
  delete(app: App): Promise<boolean>;
}

// ActivatorDeps is the I/O an activation attempt runs against. The Durable Object
// builds a fresh set per execution (a fresh pg client, R2-backed blobs); the
// tests pass in-memory doubles.
export interface ActivatorDeps {
  store: Store;
  blobs: BlobStore;
  runtime: Runtime;
}

// ---- shared attempt ----

// runtimeApp projects the control plane's app onto what a runtime is allowed to
// know about it.
export function runtimeApp(a: App | RuntimeApp): RuntimeApp {
  return {
    id: a.id,
    slug: a.slug,
    framework: a.framework,
    script: a.script,
    salt: a.salt,
    storeId: a.storeId,
  };
}

// activationFailure makes a runtime failure agent-actionable, as a plain error
// object to persist. Activation failures are attempt-scoped: re-running push
// reopens the deploy, so the fix is always literally that.
export function activationFailure(err: unknown): DeployError {
  const shaped = deployShaped(err);
  if (shaped !== null) return shaped;
  return {
    code: DeployCode.Unavailable,
    message: 'activation failed on the platform: ' + errText(err),
    fix: 'run 280 push again',
    retryable: false,
    candidates: [],
  };
}

// deleteFailed reports a substrate that would not let go, as the contract's
// throwable so its fields survive every caller. Nothing is half deleted at this
// point that re-running would not finish, so it is retryable rather than an error
// with a fix of its own.
export function deleteFailed(what: string, err: unknown): DeployErr {
  const de = asDeployErr(err);
  if (de !== null) return de;
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `could not ${what}: ${errText(err)}`,
    retryable: true,
  });
}

// runAttempt performs one activation attempt against deps: claim the deploy if it
// is still uploading (proceed under an existing claim if it has already moved to
// activating — an alarm retry, or a resumed attempt after an eviction), run the
// runtime, persist the store id before the outcome, and mark the deploy live.
// Persisting the store id first matters: a store the runtime created but the
// control plane forgot would be re-created on the next push and the app's data
// would vanish.
//
// It throws the runtime's error on failure, leaving the deploy in activating; the
// caller decides whether to fail the deploy (InProcessActivator, one shot) or
// retry (ActivatorCore, under the alarm). A deploy someone else already finished,
// or a claim lost to a racing caller, is a no-op, not an error.
export async function runAttempt(deps: ActivatorDeps, app: App, dep: Deploy): Promise<void> {
  if (stateTerminal(dep.state)) return; // already finished
  if (dep.state === State.Uploading) {
    const won = await deps.store.claimActivation(app.id, dep.id);
    if (!won) {
      // Lost the claim between the read and the update: report whatever the store
      // now says. If it is terminal, someone finished it; if it is activating, we
      // (or a racing caller) own it and proceed.
      const now = await deps.store.deploy(app.id, dep.id);
      if (now === null || stateTerminal(now.state)) return;
    }
  }

  const res = await deps.runtime.activate({
    app: runtimeApp(app),
    deployId: dep.id,
    manifest: dep.manifest,
    asset: (d: Digest) => deps.blobs.get(app.id, d),
  });

  if (res.storeId !== '' && res.storeId !== app.storeId) {
    await deps.store.setStoreId(app.id, res.storeId);
  }
  await deps.store.finishLive(app.id, dep.id);
}

// runTail is the destructive half of a delete, shared by both activators: the
// runtime first, then content, then the row that names them. Every step is
// idempotent and each only makes sense while the row still exists, so an
// interruption anywhere leaves an app that running the same command again
// finishes off. Throws a plain DeployError on failure.
export async function runTail(deps: ActivatorDeps, app: RuntimeApp, accountId: string): Promise<boolean> {
  try {
    await deps.runtime.delete(app);
  } catch (err) {
    throw deleteFailed('remove the app from the runtime', err);
  }
  try {
    await deps.blobs.deleteApp(app.id);
    return await deps.store.deleteApp(accountId, app.id);
  } catch (err) {
    throw internal('delete app content', err);
  }
}

// ---- in-process (tests / conformance) ----

// InProcessActivator runs activation and delete synchronously in the calling
// isolate, serialized per app by a promise chain (the single-isolate equivalent
// of the retired withAppLock). It reproduces the old inline settle exactly: one
// activation attempt, a failure recorded as the deploy's terminal failure. The
// tests and the conformance suite depend on a deploy being live the moment its
// last blob lands, which only this synchronous form provides.
export class InProcessActivator implements Activator {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ActivatorDeps) {}

  activate(app: App, deployId: string): Promise<void> {
    return this.withLock(app.id, async () => {
      const dep = await this.deps.store.deploy(app.id, deployId);
      if (dep === null || stateTerminal(dep.state)) return;
      try {
        await runAttempt(this.deps, app, dep);
      } catch (err) {
        await this.deps.store.finishFailed(app.id, deployId, activationFailure(err));
      }
    });
  }

  delete(app: App): Promise<boolean> {
    // runTail throws the contract's DeployErr on failure; it propagates unchanged
    // through Service.delete's wrapInternal to the caller.
    return this.withLock(app.id, () => runTail(this.deps, runtimeApp(app), app.accountId));
  }

  // withLock serializes fn against every other activation or delete of the same
  // app, the same per-app promise chain the retired withAppLock used.
  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const result = prev.then(() => fn());
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(appId, tail);
    void tail.then(() => {
      if (this.locks.get(appId) === tail) this.locks.delete(appId);
    });
    return result;
  }
}

// ---- Durable Object client (production) ----

// ActivateParams and DeleteParams cross the Durable Object RPC boundary, so they
// are plain structured-cloneable objects. The delete carries the runtime
// projection the request already resolved rather than an app id the object would
// re-read, so a concurrent delete cannot leave it without a script name to
// remove.
export interface ActivateParams {
  appId: string;
  accountId: string;
  deployId: string;
}

export interface DeleteParams {
  app: RuntimeApp;
  accountId: string;
}

// DeleteOutcome is the delete RPC's return: a delete-domain failure comes back as
// data (a plain DeployError) rather than a thrown value, so the object's custom
// error fields survive the RPC serialization the caller relies on.
export type DeleteOutcome = { deleted: boolean } | { error: DeployError };

// AppActivatorStub is the structural view of the Durable Object's RPC surface.
// Typed here rather than imported from the object's own module so this file never
// pulls in `cloudflare:workers` (which does not resolve under node).
export interface AppActivatorStub {
  activate(params: ActivateParams): Promise<void>;
  delete(params: DeleteParams): Promise<DeleteOutcome>;
}

// DurableObjectActivator forwards to the app's AppActivator Durable Object. It
// holds no I/O of its own: the object builds its own per-execution deps from the
// same env this Worker sees.
export class DurableObjectActivator implements Activator {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  private stub(appId: string): AppActivatorStub {
    const id = this.namespace.idFromName(appId);
    return this.namespace.get(id) as unknown as AppActivatorStub;
  }

  // activate hands the deploy to the object, which persists a task and arms an
  // alarm before returning. The claim and the runtime round trip happen inside
  // the object under that alarm, so this returns before the activation completes.
  async activate(app: App, deployId: string): Promise<void> {
    await this.stub(app.id).activate({ appId: app.id, accountId: app.accountId, deployId });
  }

  async delete(app: App): Promise<boolean> {
    const outcome = await this.stub(app.id).delete({ app: runtimeApp(app), accountId: app.accountId });
    // The object returns a delete-domain failure as data; rebuild the contract's
    // throwable from it so its code/fix/retryable reach the caller intact.
    if ('error' in outcome) throw new DeployErr(outcome.error);
    return outcome.deleted;
  }
}

// ---- durable executor (Durable Object core) ----

// TaskRecord is the whole of what the object persists: the app and deploy it is
// activating, how many attempts have failed, and when it started. Nothing large
// ever enters durable storage — no asset bytes, no session tokens.
export interface TaskRecord {
  appId: string;
  accountId: string;
  deployId: string;
  attempt: number;
  startedAt: number; // ms since epoch, from the executor's clock
}

// TaskStorage is the subset of DurableObjectStorage the executor uses. The real
// storage satisfies it structurally; a node test passes a fake so the same
// executor is exercised without Miniflare.
export interface TaskStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

// ActivatorOptions tunes the retry/watchdog behavior. Defaults are production
// values; tests shrink them to keep runs fast.
export interface ActivatorOptions {
  // stuckMs is how long a task may live before the watchdog fails it. Ten minutes
  // is longer than any real activation and the edge lag behind it, so a task
  // still running at that point is wedged, not slow.
  stuckMs?: number;
  // attemptCap bounds retries independently of the clock, so a fast-failing
  // activation does not spin for ten minutes.
  attemptCap?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

const TASK_KEY = 'task';
const DEFAULT_STUCK_MS = 10 * 60 * 1000;
const DEFAULT_ATTEMPT_CAP = 15;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

// ActivatorCore is the Durable Object's executor. It owns the single promise
// chain that serializes this app's activation and delete, the task record that is
// the durable ownership token for an in-flight activation, and the alarm that
// re-drives a lost or failed attempt. It touches no `cloudflare:workers` type, so
// it runs unchanged under Miniflare (real storage) and under a node fake.
export class ActivatorCore {
  private readonly storage: TaskStorage;
  private readonly depsFactory: () => ActivatorDeps;
  private readonly now: () => number;
  private readonly log: Logger | undefined;
  private readonly stuckMs: number;
  private readonly attemptCap: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;

  // chain serializes execute() (alarm-driven activation) against delete(), so the
  // object performs one operation at a time. It never rejects, so the next
  // operation proceeds whatever the last one did.
  private chain: Promise<unknown> = Promise.resolve();
  // busy guards the idempotent enqueue path from arming a redundant alarm while an
  // execution is already running. In-memory only: on eviction there is no running
  // execution, and the persisted alarm is what recovers the task.
  private busy = false;

  constructor(opts: {
    storage: TaskStorage;
    depsFactory: () => ActivatorDeps;
    now: () => number;
    log?: Logger;
    options?: ActivatorOptions;
  }) {
    this.storage = opts.storage;
    this.depsFactory = opts.depsFactory;
    this.now = opts.now;
    this.log = opts.log;
    this.stuckMs = opts.options?.stuckMs ?? DEFAULT_STUCK_MS;
    this.attemptCap = opts.options?.attemptCap ?? DEFAULT_ATTEMPT_CAP;
    this.backoffBaseMs = opts.options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = opts.options?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  }

  // enqueue persists the task and arms the alarm, then returns. It does no
  // activation work — that runs in the alarm — so the request that triggered it
  // (the last blob's settle) is not held open for the runtime round trip. It is
  // idempotent for the same deploy: a re-sync of a still-activating deploy must
  // not reset the attempt count or cut the backoff. A different deploy id (a newer
  // push) supersedes the tracked task.
  async enqueue(params: ActivateParams): Promise<void> {
    const existing = await this.storage.get<TaskRecord>(TASK_KEY);
    if (existing && existing.deployId === params.deployId) {
      // Already tracking this deploy. Only re-arm if nothing is running or
      // scheduled to drive it (a prior arm lost to an interrupted enqueue);
      // otherwise leave the in-flight schedule and its backoff untouched.
      if (!this.busy && (await this.storage.getAlarm()) === null) {
        await this.storage.setAlarm(this.now());
      }
      return;
    }
    await this.storage.put<TaskRecord>(TASK_KEY, {
      appId: params.appId,
      accountId: params.accountId,
      deployId: params.deployId,
      attempt: 0,
      startedAt: this.now(),
    });
    await this.storage.setAlarm(this.now());
  }

  // onAlarm is the executor entry. It runs through the chain so it serializes with
  // any delete of the same app.
  onAlarm(): Promise<void> {
    return this.serialize(() => this.execute());
  }

  // runDelete performs a delete through the chain, so it waits for any in-flight
  // activation to finish before touching the runtime. It clears the pending task
  // first: a delete supersedes an in-flight or queued activation, and dropping the
  // task keeps a later alarm from re-uploading the worker after it is removed.
  async runDelete(params: DeleteParams): Promise<DeleteOutcome> {
    return this.serialize(async () => {
      await this.clearTask();
      const deps = this.depsFactory();
      try {
        const deleted = await runTail(deps, params.app, params.accountId);
        return { deleted } as DeleteOutcome;
      } catch (err) {
        return { error: toDeployError(err) };
      } finally {
        await safeClose(deps);
      }
    });
  }

  // execute runs one activation attempt for the current task. It re-reads the app
  // and deploy from the store every time (a missing app means the app was deleted;
  // a terminal deploy means someone finished it), performs the attempt, and on a
  // runtime failure increments the attempt and re-arms the alarm with backoff. The
  // watchdog is checked first: a task older than stuckMs or past the attempt cap is
  // failed with a retryable error and cleared, so it can never wedge the deploy in
  // activating (the CLI's poll loop has no attempt cap of its own).
  private async execute(): Promise<void> {
    this.busy = true;
    try {
      const task = await this.storage.get<TaskRecord>(TASK_KEY);
      if (!task) {
        await this.storage.deleteAlarm();
        return;
      }
      if (this.now() - task.startedAt > this.stuckMs || task.attempt >= this.attemptCap) {
        await this.failStuck(task);
        return;
      }

      // Escape hatch, designed but deliberately not built: a deploy whose asset
      // bucket uploads would exceed the isolate's memory could split those uploads
      // across successive alarm invocations, persisting a cursor in the task. It is
      // only worth building if a real deploy proves it necessary; KV_BULK_MAX_BYTES
      // and the 16 MiB isolate cap (cloudflare.ts) keep the common case well under.

      const deps = this.depsFactory();
      try {
        const app = await deps.store.app(task.accountId, task.appId);
        if (app === null) {
          await this.clearTask(); // app deleted out from under the activation
          return;
        }
        const dep = await deps.store.deploy(task.appId, task.deployId);
        if (dep === null || stateTerminal(dep.state)) {
          await this.clearTask(); // gone or already finished
          return;
        }
        await runAttempt(deps, app, dep);
        await this.clearTask();
      } catch (err) {
        await this.retry(task, err);
      } finally {
        await safeClose(deps);
      }
    } finally {
      this.busy = false;
    }
  }

  private async retry(task: TaskRecord, err: unknown): Promise<void> {
    const attempt = task.attempt + 1;
    await this.storage.put<TaskRecord>(TASK_KEY, { ...task, attempt });
    const delay = this.backoff(attempt);
    await this.storage.setAlarm(this.now() + delay);
    this.log?.warn('activation attempt failed; retrying', {
      app: task.appId,
      deploy: task.deployId,
      attempt,
      delayMs: delay,
      error: errText(err),
    });
  }

  // failStuck fails a wedged activation with a retryable error and clears the
  // task. failed is the one state openDeploy reopens, so the next push resumes
  // cleanly. If recording the failure itself fails (a database outage), the task
  // is left and the alarm re-armed so a later firing retries the finishFailed.
  private async failStuck(task: TaskRecord): Promise<void> {
    const deps = this.depsFactory();
    try {
      await deps.store.finishFailed(task.appId, task.deployId, {
        code: DeployCode.Unavailable,
        message: 'activation timed out on the platform',
        fix: 'run 280 push again',
        retryable: true,
        candidates: [],
      });
    } catch (err) {
      this.log?.error('failed to record a timed-out activation; will retry', {
        app: task.appId,
        deploy: task.deployId,
        error: errText(err),
      });
      await this.storage.setAlarm(this.now() + this.backoff(task.attempt || 1));
      await safeClose(deps);
      return;
    }
    await safeClose(deps);
    await this.clearTask();
  }

  private async clearTask(): Promise<void> {
    await this.storage.delete(TASK_KEY);
    await this.storage.deleteAlarm();
  }

  // backoff doubles the base per attempt, capped. Attempt 1 is the base.
  private backoff(attempt: number): number {
    let d = this.backoffBaseMs;
    for (let i = 1; i < attempt && d < this.backoffCapMs; i++) d *= 2;
    return Math.min(d, this.backoffCapMs);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => fn());
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// toDeployError normalizes any thrown value into the plain error shape the delete
// RPC returns. runTail throws the contract's DeployErr (a deploy-shaped value);
// anything else is mapped to a retryable internal error.
function toDeployError(err: unknown): DeployError {
  return deployShaped(err) ?? deployShaped(internal('delete app', err))!;
}

// safeClose ends a per-execution store client, swallowing a close fault (the
// outcome of the operation is what matters, not the teardown).
async function safeClose(deps: ActivatorDeps): Promise<void> {
  try {
    await deps.store.close();
  } catch {
    // teardown only
  }
}
