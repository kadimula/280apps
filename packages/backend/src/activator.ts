import {
  DeployCode,
  DeployErr,
  State,
  publicConfig,
  requiredConfigNames,
  stateTerminal,
  type DeployError,
  type Manifest,
} from '@280/contracts';
import type { App, BlobStore, ConfigDelivery, Deploy, ContainerApp, Store } from './seams.js';
import type { ContainerBuilder, RolloutJob } from './runtime/container/container.js';
import { asDeployErr, deployShaped, errText, internal } from './deploysvc.js';

export interface ContainerDeploymentDeps {
  store: Store;
  blobs: BlobStore;
  builder: ContainerBuilder;
  config?: ConfigDelivery;
  now?: () => number;
}

export function containerApp(app: App | ContainerApp): ContainerApp {
  return { id: app.id, script: app.script };
}

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

export function deleteFailed(what: string, err: unknown): DeployErr {
  const deployError = asDeployErr(err);
  if (deployError !== null) return deployError;
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `could not ${what}: ${errText(err)}`,
    retryable: true,
  });
}

function deploymentFailed(err: unknown): DeployErr {
  if (err instanceof DeployErr) return err;
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: 'container deployment failed on the platform: ' + errText(err),
    retryable: true,
  });
}

function rolloutJob(deps: ContainerDeploymentDeps, app: App, dep: Deploy): RolloutJob {
  return {
    app: containerApp(app),
    deployId: dep.id,
    build: dep.manifest.build,
    files: dep.manifest.files.map((file) => ({
      path: file.path,
      read: () => deps.blobs.get(app.id, file.digest),
    })),
    runtime: {
      routes: dep.manifest.routes ?? [],
      env: publicConfig(dep.manifest.config ?? []),
    },
  };
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export class ContainerDeploymentCoordinator {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ContainerDeploymentDeps) {}

  activate(app: App, deployId: string): Promise<void> {
    return this.withLock(app.id, async () => {
      const dep = await this.deps.store.deploy(app.id, deployId);
      if (dep === null || stateTerminal(dep.state)) return;
      try {
        await this.runAttempt(app, dep);
      } catch (err) {
        await this.deps.store.finishFailed(app.id, deployId, activationFailure(err));
      }
    });
  }

  delete(app: App): Promise<boolean> {
    return this.withLock(app.id, () => this.runDelete(containerApp(app), app.userId));
  }

  private async runAttempt(app: App, dep: Deploy): Promise<void> {
    let state = dep.state;
    if (state === State.Uploading) {
      if (!(await this.deps.store.claimActivation(app.id, dep.id))) return;
      state = State.Activating;
    }

    const job = rolloutJob(this.deps, app, dep);
    if (state === State.Activating) await this.prepare(job);

    // One readiness gate for what a human must still supply before the app can serve:
    // required config values (sensitive, no committed value) and bound integration
    // aliases. When anything is missing the deploy parks (no rollout, no spin, no
    // credential request); a re-check after parking closes the race with a
    // just-completed setup.
    const config = dep.manifest.config ?? [];
    if (await this.setupPending(app.id, dep.manifest)) {
      await this.deps.store.parkActivation(app.id, dep.id, (this.deps.now ?? nowSecs)());
      if (await this.setupPending(app.id, dep.manifest)) return;
      state = State.WaitingSecrets;
    }

    if (state === State.WaitingSecrets && !(await this.deps.store.resumeActivation(app.id, dep.id))) return;

    if (this.deps.config) job.runtime.env = await this.deps.config.resolve(job.app, config);
    await this.rollout(job);
    await this.deps.store.finishLive(app.id, dep.id);
  }

  private async prepare(job: RolloutJob): Promise<void> {
    try {
      await this.deps.builder.build(job);
    } catch (err) {
      throw deploymentFailed(err);
    }
  }

  private async rollout(job: RolloutJob): Promise<void> {
    try {
      await this.deps.builder.rollout(job, this.deps.builder.imageRef(job.app, job.deployId));
    } catch (err) {
      throw deploymentFailed(err);
    }
  }

  // The park gate mirrors the original secret discipline: only required CONFIG
  // (sensitive, no committed value) blocks serving, not declared secrets — those are
  // backend-held and delivered separately, so declaring one never waits. Integration
  // aliases with no bound resource block the same way. A store fault fails safe
  // (treated as pending), so a transient error can never let a deploy roll out.
  private async setupPending(appId: string, manifest: Manifest): Promise<boolean> {
    const requiredCfg = requiredConfigNames(manifest.config ?? []);
    if (requiredCfg.length > 0 && (await this.namesUnconfigured(appId, requiredCfg))) return true;
    for (const r of manifest.integrations ?? []) {
      const bound = await this.deps.store.resourceByAlias(appId, r.capability, r.alias).catch(() => null);
      if (bound === null) return true;
    }
    return false;
  }

  private async namesUnconfigured(appId: string, names: string[]): Promise<boolean> {
    try {
      const present = new Set(await this.deps.store.appSecretNames(appId));
      return names.some((name) => !present.has(name));
    } catch {
      return true;
    }
  }

  private async runDelete(app: ContainerApp, userId: string): Promise<boolean> {
    try {
      await this.deps.builder.teardown(app);
    } catch (err) {
      throw deleteFailed('delete container', err);
    }
    try {
      await this.deps.blobs.deleteApp(app.id);
      return await this.deps.store.deleteApp(userId, app.id);
    } catch (err) {
      throw internal('delete app content', err);
    }
  }

  private withLock<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(appId) ?? Promise.resolve();
    const result = previous.then(operation);
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
