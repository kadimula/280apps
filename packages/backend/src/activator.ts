// The per-app executor that turns a content-complete deploy into the app's
// serving version, and runs the destructive tail of a delete. Two Activator
// implementations serialize a single app's activation and delete against each
// other: DurableObjectActivator (production, one AppActivator DO per app) and
// InProcessActivator (tests/conformance, inline and synchronous). ActivatorCore
// is the storage-agnostic executor the DO delegates to, so the same code runs
// under Miniflare and under a node fake with a controllable clock.

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

export interface Activator {
  // Must return before the activation completes, so the request that landed the
  // last blob is not held open for the runtime round trip.
  activate(app: App, deployId: string): Promise<void>;

  // Runtime, then blobs, then the row, in that order; serialized against any
  // activation of the same app. Reports whether a row was removed.
  delete(app: App): Promise<boolean>;
}

// The DO builds a fresh set per execution (a fresh pg client, R2-backed blobs);
// tests pass in-memory doubles.
export interface ActivatorDeps {
  store: Store;
  blobs: BlobStore;
  runtime: Runtime;
}

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

// Activation failures are attempt-scoped: re-running push reopens the deploy, so
// the fix is always literally that.
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

// Nothing is half deleted that re-running would not finish, so it is retryable
// rather than an error with a fix of its own.
export function deleteFailed(what: string, err: unknown): DeployErr {
  const de = asDeployErr(err);
  if (de !== null) return de;
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `could not ${what}: ${errText(err)}`,
    retryable: true,
  });
}

// Persisting the store id before the outcome matters: a store the runtime
// created but the control plane forgot would be re-created on the next push and
// the app's data would vanish. Throws the runtime's error on failure, leaving the
// deploy in activating for the caller to fail (one shot) or retry (under alarm).
export async function runAttempt(deps: ActivatorDeps, app: App, dep: Deploy): Promise<void> {
  if (stateTerminal(dep.state)) return;
  if (dep.state === State.Uploading) {
    const won = await deps.store.claimActivation(app.id, dep.id);
    if (!won) {
      // Lost the claim between read and update: a terminal state means someone
      // finished it; activating means we (or a racing caller) own it and proceed.
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

// The destructive half of a delete: runtime, then content, then the row that
// names them. Every step is idempotent and only makes sense while the row still
// exists, so an interruption anywhere leaves an app that re-running finishes off.
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

// Runs activation and delete synchronously in the calling isolate, serialized per
// app by a promise chain. Tests and conformance depend on a deploy being live the
// moment its last blob lands, which only this synchronous form provides.
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
    return this.withLock(app.id, () => runTail(this.deps, runtimeApp(app), app.accountId));
  }

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

// The delete carries the runtime projection the request already resolved rather
// than an app id the object would re-read, so a concurrent delete cannot leave it
// without a script name to remove.
export interface ActivateParams {
  appId: string;
  accountId: string;
  deployId: string;
}

export interface DeleteParams {
  app: RuntimeApp;
  accountId: string;
}

// A delete-domain failure comes back as data rather than a thrown value, so the
// object's custom error fields survive RPC serialization.
export type DeleteOutcome = { deleted: boolean } | { error: DeployError };

// Typed structurally rather than imported from the object's own module so this
// file never pulls in `cloudflare:workers` (which does not resolve under node).
export interface AppActivatorStub {
  activate(params: ActivateParams): Promise<void>;
  delete(params: DeleteParams): Promise<DeleteOutcome>;
}

// Forwards to the app's AppActivator DO, which builds its own per-execution deps
// from the same env this Worker sees.
export class DurableObjectActivator implements Activator {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  private stub(appId: string): AppActivatorStub {
    const id = this.namespace.idFromName(appId);
    return this.namespace.get(id) as unknown as AppActivatorStub;
  }

  async activate(app: App, deployId: string): Promise<void> {
    await this.stub(app.id).activate({ appId: app.id, accountId: app.accountId, deployId });
  }

  async delete(app: App): Promise<boolean> {
    const outcome = await this.stub(app.id).delete({ app: runtimeApp(app), accountId: app.accountId });
    if ('error' in outcome) throw new DeployErr(outcome.error);
    return outcome.deleted;
  }
}

export interface TaskRecord {
  appId: string;
  accountId: string;
  deployId: string;
  attempt: number;
  startedAt: number; // ms since epoch, from the executor's clock
}

// The subset of DurableObjectStorage the executor uses; real storage satisfies it
// structurally, a node test passes a fake.
export interface TaskStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

// Defaults are production values; tests shrink them to keep runs fast.
export interface ActivatorOptions {
  // How long a task may live before the watchdog fails it. Longer than any real
  // activation plus edge lag, so a task still running by then is wedged, not slow.
  stuckMs?: number;
  // Bounds retries independently of the clock, so a fast-failing activation does
  // not spin for the full stuckMs window.
  attemptCap?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

const TASK_KEY = 'task';
const DEFAULT_STUCK_MS = 10 * 60 * 1000;
const DEFAULT_ATTEMPT_CAP = 15;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

// The DO's executor: the single promise chain serializing this app's activation
// and delete, the durable task record that is the ownership token for an in-flight
// activation, and the alarm that re-drives a lost or failed attempt. Touches no
// `cloudflare:workers` type, so it runs unchanged under Miniflare and a node fake.
export class ActivatorCore {
  private readonly storage: TaskStorage;
  private readonly depsFactory: () => ActivatorDeps;
  private readonly now: () => number;
  private readonly log: Logger | undefined;
  private readonly stuckMs: number;
  private readonly attemptCap: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;

  // Serializes execute() against delete() so the object does one operation at a
  // time. Never rejects, so the next operation proceeds whatever the last one did.
  private chain: Promise<unknown> = Promise.resolve();
  // Guards the idempotent enqueue path from arming a redundant alarm while an
  // execution runs. In-memory only: on eviction the persisted alarm recovers it.
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

  // Persists the task and arms the alarm, then returns; the activation runs in the
  // alarm. Idempotent for the same deploy (a re-sync must not reset the attempt
  // count or cut the backoff); a newer push's deploy id supersedes the task.
  async enqueue(params: ActivateParams): Promise<void> {
    const existing = await this.storage.get<TaskRecord>(TASK_KEY);
    if (existing && existing.deployId === params.deployId) {
      // Re-arm only if nothing is running or scheduled to drive it (a prior arm
      // lost to an interrupted enqueue); else leave the in-flight schedule alone.
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

  onAlarm(): Promise<void> {
    return this.serialize(() => this.execute());
  }

  // Clears the pending task before deleting: a delete supersedes an in-flight or
  // queued activation, and dropping the task keeps a later alarm from re-uploading
  // the worker after it is removed.
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

  // Runs one activation attempt for the current task. The watchdog is checked
  // first: a task older than stuckMs or past the attempt cap is failed retryably
  // and cleared, so it can never wedge the deploy in activating (the CLI's poll
  // loop has no attempt cap of its own).
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

      const deps = this.depsFactory();
      try {
        const app = await deps.store.app(task.accountId, task.appId);
        if (app === null) {
          await this.clearTask();
          return;
        }
        const dep = await deps.store.deploy(task.appId, task.deployId);
        if (dep === null || stateTerminal(dep.state)) {
          await this.clearTask();
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

  // Fails a wedged activation retryably and clears the task; failed is the one
  // state openDeploy reopens, so the next push resumes cleanly. If recording the
  // failure itself fails, the task is left and the alarm re-armed to retry it.
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

  // Doubles the base per attempt, capped; attempt 1 is the base.
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

// runTail throws the contract's DeployErr; anything else maps to a retryable
// internal error.
function toDeployError(err: unknown): DeployError {
  return deployShaped(err) ?? deployShaped(internal('delete app', err))!;
}

async function safeClose(deps: ActivatorDeps): Promise<void> {
  try {
    await deps.store.close();
  } catch {
    // teardown fault: the operation's outcome is what matters, not the close
  }
}
