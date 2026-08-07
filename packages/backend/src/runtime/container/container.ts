// The container runtime: it turns a content-complete build context into a
// running Cloudflare Container application, behind the same Runtime seam the
// Workers-for-Platforms runtime used to sit behind. It is driven unchanged by
// deploysvc + the AppActivator Durable Object.
//
// The runtime itself owns no Docker and no Cloudflare API: it reads the build
// context out of the blob store and hands it to a ContainerBuilder. That builder
// is the one seam the build-home decision plugs into (the live path is DepotBuilder
// on the Node host; the self-hosted Docker/HTTP builders are retained but dormant).
// Build and rollout are separate so a completed image can wait for the owner's
// secret configuration without exposing a new serving version.

import {
  DeployCode,
  DeployErr,
  appPolicyFromManifest,
  normalizeEgressPolicy,
  type BuildSpec,
  type EgressPolicy,
} from '@280/contracts';
import type { Activation, Runtime as RuntimeSeam, RuntimeApp, RuntimeResult, SecretDelivery } from '../../seams.js';

// RolloutPolicy is the enforced slice of the app's manifest the roll bakes into the
// per-app Worker (TWO80_ROUTE_POLICY): access mode + feature roles + route gates +
// declared secret names. It is exactly appPolicyFromManifest's output.
type RolloutPolicy = ReturnType<typeof appPolicyFromManifest>;

// ContextFile is one file of the build context, read lazily so a large context
// streams file by file instead of materializing in memory all at once.
export interface ContextFile {
  path: string; // context-relative, e.g. "Dockerfile" or "app/page.tsx"
  read(): Promise<Uint8Array>;
}

// RolloutJob is everything the builder needs to make one deploy the app's serving
// image: the app identity (its stable script name is the container application
// name), the deploy id (the image tag), the build recipe, and the context files.
export interface RolloutJob {
  app: RuntimeApp;
  deployId: string;
  build: BuildSpec;
  files: ContextFile[];
  // The app's trust boundary (access + routes + roles + secret names), baked into
  // the per-app Worker so its middleware can enforce the route gate locally.
  policy: RolloutPolicy;
  // The app's outbound contract (allowed hosts + per-host credential wiring),
  // normalized, baked into the per-app Worker (EGRESS_POLICY) so the container's
  // fail-closed egress boundary and in-flight credential injection match 280.json.
  egress: EgressPolicy;
}

// RolloutResult is what a successful rollout reports back. imageRef is the pushed
// image (registry.cloudflare.com/...); it is diagnostic only in Phase 1 — the
// control plane addresses the app by its deterministic script name, so nothing
// here has to be persisted through the unchanged RuntimeResult.
export interface RolloutResult {
  imageRef: string;
}

// ContainerBuilder is the build-home boundary. Build pushes the image without
// changing the serving app; rollout switches the app to that deterministic image.
// Every method is idempotent.
export interface ContainerBuilder {
  imageRef(app: RuntimeApp, deployId: string): string;
  build(job: RolloutJob): Promise<RolloutResult>;
  rollout(job: RolloutJob, imageRef: string): Promise<void>;
  teardown(app: RuntimeApp): Promise<void>;
}

// buildFailed shapes a builder error as the seam's agent-actionable throwable.
// A deterministic build failure (the app's own Dockerfile/build) carries the log
// tail and a fix and is marked non-retryable; a transient one (cannot reach the
// build host) stays retryable so the loop tries again. The builder decides which
// by throwing a DeployErr itself; anything else is treated as retryable infra.
function buildFailed(err: unknown): DeployErr {
  if (err instanceof DeployErr) return err;
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: 'container build failed on the platform: ' + errText(err),
    retryable: true,
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ContainerRuntime implements RuntimeSeam {
  private readonly prepared = new Set<string>();

  constructor(
    private readonly builder: ContainerBuilder,
    private readonly secrets?: SecretDelivery,
  ) {}

  private job(act: Activation): RolloutJob {
    return {
      app: act.app,
      deployId: act.deployId,
      build: act.manifest.build,
      files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
      policy: appPolicyFromManifest(act.manifest),
      egress: normalizeEgressPolicy(act.manifest.egress ?? { allowedHosts: [], credentials: [] }),
    };
  }

  async prepare(act: Activation): Promise<void> {
    try {
      await this.builder.build(this.job(act));
      this.prepared.add(`${act.app.id}/${act.deployId}`);
    } catch (err) {
      throw buildFailed(err);
    }
  }

  async activate(act: Activation): Promise<RuntimeResult> {
    const job = this.job(act);
    const key = `${act.app.id}/${act.deployId}`;
    if (!this.prepared.has(key)) await this.prepare(act);
    try {
      await this.builder.rollout(job, this.builder.imageRef(job.app, job.deployId));
      await this.secrets?.rollout(act.app, job.policy.secrets);
    } catch (err) {
      throw buildFailed(err);
    } finally {
      this.prepared.delete(key);
    }
    return { storeId: '' };
  }

  async delete(app: RuntimeApp): Promise<void> {
    try {
      await this.builder.teardown(app);
    } catch (err) {
      throw buildFailed(err);
    }
  }
}

// FakeBuilder records rollouts and teardowns instead of performing them, so the
// container runtime can be exercised without Docker or Cloudflare. Optional
// one-shot failure injection mirrors MemoryRuntime.failNext for the tests that
// assert the seam surfaces a build failure as an activation failure.
export class FakeBuilder implements ContainerBuilder {
  readonly builds: RolloutJob[] = [];
  readonly rollouts: RolloutJob[] = [];
  readonly torndown: string[] = [];
  private failWith: Error | null = null;

  failNext(err: Error): void {
    this.failWith = err;
  }

  imageRef(app: RuntimeApp, deployId: string): string {
    return `registry.cloudflare.com/fake/${app.script}:${deployId}`;
  }

  async build(job: RolloutJob): Promise<RolloutResult> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    for (const f of job.files) await f.read();
    this.builds.push(job);
    return { imageRef: this.imageRef(job.app, job.deployId) };
  }

  async rollout(job: RolloutJob, _imageRef: string): Promise<void> {
    this.rollouts.push(job);
  }

  async teardown(app: RuntimeApp): Promise<void> {
    this.torndown.push(app.id);
  }
}
