// The container runtime: it turns a content-complete build context into a
// running Cloudflare Container application, behind the same Runtime seam the
// Workers-for-Platforms runtime used to sit behind. It is driven unchanged by
// deploysvc + the AppActivator Durable Object.
//
// The runtime itself owns no Docker and no Cloudflare API: it reads the build
// context out of the blob store and hands it to a ContainerBuilder. That builder
// is the one seam the build-home decision plugs into (self-hosted Docker builder,
// reached over HTTP from the Workers control plane; run directly in a node
// harness for the local proof). Splitting build/push/rollout further would be
// fiction: wrangler does them as a unit, so the builder does too.

import { DeployCode, DeployErr, type BuildSpec } from '@280/contracts';
import type { Activation, Runtime as RuntimeSeam, RuntimeApp, RuntimeResult } from '../../seams.js';

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
}

// RolloutResult is what a successful rollout reports back. imageRef is the pushed
// image (registry.cloudflare.com/...); it is diagnostic only in Phase 1 — the
// control plane addresses the app by its deterministic script name, so nothing
// here has to be persisted through the unchanged RuntimeResult.
export interface RolloutResult {
  imageRef: string;
}

// ContainerBuilder is the build-home boundary: build the image from the context,
// push it to registry.cloudflare.com, and create or roll the app's container
// application. Both methods are idempotent — a retried activation converges on
// the same image and application; a repeated teardown of a gone app is success.
export interface ContainerBuilder {
  rollout(job: RolloutJob): Promise<RolloutResult>;
  teardown(app: RuntimeApp): Promise<void>;
}

// buildFailed shapes a builder error as the seam's agent-actionable throwable.
// A deterministic build failure (the app's own Dockerfile/build) carries the log
// tail and a fix and is marked non-retryable; a transient one (cannot reach the
// build host) stays retryable so the loop tries again. The builder decides which
// by throwing a DeployErr itself; anything else is treated as retryable infra.
export function buildFailed(err: unknown): DeployErr {
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
  constructor(private readonly builder: ContainerBuilder) {}

  async activate(act: Activation): Promise<RuntimeResult> {
    const files: ContextFile[] = act.manifest.files.map((f) => ({
      path: f.path,
      read: () => act.asset(f.digest),
    }));
    try {
      await this.builder.rollout({
        app: act.app,
        deployId: act.deployId,
        build: act.manifest.build,
        files,
      });
    } catch (err) {
      throw buildFailed(err);
    }
    // No per-app store in Phase 1; the container is addressed by its script name.
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
  readonly rollouts: RolloutJob[] = [];
  readonly torndown: string[] = [];
  private failWith: Error | null = null;

  failNext(err: Error): void {
    this.failWith = err;
  }

  async rollout(job: RolloutJob): Promise<RolloutResult> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    // Read every file the way a real builder would when it assembles the context,
    // so a manifest naming a blob nobody uploaded fails here, not silently.
    for (const f of job.files) await f.read();
    this.rollouts.push(job);
    return { imageRef: `registry.cloudflare.com/fake/${job.app.script}:${job.deployId}` };
  }

  async teardown(app: RuntimeApp): Promise<void> {
    this.torndown.push(app.id);
  }
}
