// InProcessActivator turns a content-complete deploy into the app's serving
// version and runs the destructive tail of a delete, serializing a single app's
// activation and delete against each other inline and synchronously.

import {
  DeployCode,
  DeployErr,
  State,
  requiredConfigNames,
  stateTerminal,
  type Digest,
  type DeployError,
} from '@280/contracts';
import type { App, BlobStore, Deploy, Runtime, RuntimeApp, Store } from './seams.js';
import { asDeployErr, deployShaped, errText, internal } from './deploysvc.js';

export interface Activator {
  // Must return before the activation completes, so the request that landed the
  // last blob is not held open for the runtime round trip.
  activate(app: App, deployId: string): Promise<void>;

  // Runtime, then blobs, then the row, in that order; serialized against any
  // activation of the same app. Reports whether a row was removed.
  delete(app: App): Promise<boolean>;
}

export interface ActivatorDeps {
  store: Store;
  blobs: BlobStore;
  runtime: Runtime;
  now?: () => number;
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
    fix: 'run two80 push again',
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
  let state = dep.state;
  if (state === State.Uploading) {
    if (!(await deps.store.claimActivation(app.id, dep.id))) return;
    state = State.Activating;
  }

  const act = {
    app: runtimeApp(app),
    deployId: dep.id,
    manifest: dep.manifest,
    asset: (d: Digest) => deps.blobs.get(app.id, d),
  };

  if (state === State.Activating) await deps.runtime.prepare(act);

  // The deploy parks until every value a human must enter is present: declared
  // secrets and required config (sensitive config with no committed value). Both
  // share app_secrets, so one presence check by name covers them.
  const required = [...(dep.manifest.secrets ?? []), ...requiredConfigNames(dep.manifest.config ?? [])];
  if (required.length > 0 && (await secretsUnconfigured(deps, app.id, required))) {
    await deps.store.parkActivation(app.id, dep.id, (deps.now ?? nowSecs)());
    // A value saved between the check above and the park found nothing to resume;
    // re-checking after the park closes that window.
    if (await secretsUnconfigured(deps, app.id, required)) return;
    state = State.WaitingSecrets;
  }

  if (state === State.WaitingSecrets && !(await deps.store.resumeActivation(app.id, dep.id))) return;

  const res = await deps.runtime.activate(act);
  if (res.storeId !== '' && res.storeId !== app.storeId) await deps.store.setStoreId(app.id, res.storeId);
  await deps.store.finishLive(app.id, dep.id);
}

async function secretsUnconfigured(deps: ActivatorDeps, appId: string, names: string[]): Promise<boolean> {
  try {
    const present = new Set(await deps.store.appSecretNames(appId));
    return names.some((name) => !present.has(name));
  } catch {
    return true;
  }
}

// The destructive half of a delete: runtime, then content, then the row that
// names them. Every step is idempotent and only makes sense while the row still
// exists, so an interruption anywhere leaves an app that re-running finishes off.
export async function runTail(deps: ActivatorDeps, app: RuntimeApp, userId: string): Promise<boolean> {
  try {
    await deps.runtime.delete(app);
  } catch (err) {
    throw deleteFailed('remove the app from the runtime', err);
  }
  try {
    await deps.blobs.deleteApp(app.id);
    return await deps.store.deleteApp(userId, app.id);
  } catch (err) {
    throw internal('delete app content', err);
  }
}

// Runs activation and delete synchronously in the calling isolate, serialized per
// app by a promise chain. Tests and conformance depend on a deploy being live the
// moment its last blob lands, which only this synchronous form provides.
function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

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
    return this.withLock(app.id, () => runTail(this.deps, runtimeApp(app), app.userId));
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
