// Turns a content-complete build context into a running Cloudflare Container app,
// via the ContainerBuilder build-home seam (live path: DepotBuilder on the Node
// host). Build and rollout are separate so a completed image can wait on the
// owner's secret configuration before it goes live.

import {
  DeployCode,
  DeployErr,
  appPolicyFromManifest,
  normalizeEgressPolicy,
  publicConfig,
  type BuildSpec,
  type EgressPolicy,
} from '@280/contracts';
import type {
  Activation,
  ConfigDelivery,
  Runtime as RuntimeSeam,
  RuntimeApp,
  RuntimeResult,
  SecretDelivery,
} from '../../seams.js';

// The manifest slice baked into the per-app Worker as TWO80_ROUTE_POLICY: access
// mode, feature roles, route gates, and declared secret names.
type RolloutPolicy = ReturnType<typeof appPolicyFromManifest>;

// Read lazily so a large build context streams instead of loading fully into memory.
export interface ContextFile {
  path: string; // relative to the build context root, e.g. "Dockerfile"
  read(): Promise<Uint8Array>;
}

export interface RolloutJob {
  app: RuntimeApp;
  deployId: string;
  build: BuildSpec;
  files: ContextFile[];
  // The app's trust boundary, baked into the per-app Worker so its middleware
  // enforces the route gate locally.
  policy: RolloutPolicy;
  // Normalized outbound contract baked into the per-app Worker (EGRESS_POLICY):
  // fail-closed egress boundary plus in-flight credential injection, per 280.json.
  egress: EgressPolicy;
  // Committed-public config values (TWO80_CONFIG); dashboard-entered values are
  // merged in by ConfigDelivery at rollout. Never carries a secret value.
  config: Record<string, string>;
}

// imageRef is diagnostic only: the control plane addresses the app by its
// deterministic script name, not by this pushed image ref.
export interface RolloutResult {
  imageRef: string;
}

// The build-home boundary: build pushes an image without touching the serving
// app; rollout switches the app to it. Every method is idempotent.
export interface ContainerBuilder {
  imageRef(app: RuntimeApp, deployId: string): string;
  build(job: RolloutJob): Promise<RolloutResult>;
  rollout(job: RolloutJob, imageRef: string): Promise<void>;
  teardown(app: RuntimeApp): Promise<void>;
}

// Deterministic build failures (bad Dockerfile) are non-retryable with a log tail
// and fix; anything else is treated as transient/retryable infra.
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
    private readonly config?: ConfigDelivery,
  ) {}

  private buildJob(act: Activation): RolloutJob {
    return {
      app: act.app,
      deployId: act.deployId,
      build: act.manifest.build,
      files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
      policy: appPolicyFromManifest(act.manifest),
      egress: normalizeEgressPolicy(act.manifest.egress ?? { allowedHosts: [], credentials: [] }),
      // Dashboard-entered values are merged in by activate() via ConfigDelivery.
      config: publicConfig(act.manifest.config ?? []),
    };
  }

  async prepare(act: Activation): Promise<void> {
    try {
      await this.builder.build(this.buildJob(act));
      this.prepared.add(`${act.app.id}/${act.deployId}`);
    } catch (err) {
      throw buildFailed(err);
    }
  }

  async activate(act: Activation): Promise<RuntimeResult> {
    const job = this.buildJob(act);
    if (this.config) job.config = await this.config.resolve(act.app, act.manifest.config ?? []);
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

// Records rollouts/teardowns instead of performing them, so the runtime can be
// exercised without Docker or Cloudflare. failNext injects one build failure.
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
