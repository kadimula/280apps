import type { BuildSpec, RouteGate } from '@280/contracts';
import type { ContainerApp } from '../../seams.js';

export interface ContextFile {
  path: string;
  read(): Promise<Uint8Array>;
}

export interface RolloutJob {
  app: ContainerApp;
  deployId: string;
  build: BuildSpec;
  files: ContextFile[];
  runtime: {
    routes: RouteGate[];
    env: Record<string, string>;
  };
}

export interface RolloutResult {
  imageRef: string;
}

export interface ContainerBuilder {
  imageRef(app: ContainerApp, deployId: string): string;
  build(job: RolloutJob): Promise<RolloutResult>;
  rollout(job: RolloutJob, imageRef: string): Promise<void>;
  teardown(app: ContainerApp): Promise<void>;
}

export class FakeBuilder implements ContainerBuilder {
  readonly builds: RolloutJob[] = [];
  readonly rollouts: RolloutJob[] = [];
  readonly torndown: string[] = [];
  private readonly active = new Map<string, string>();
  private failWith: Error | null = null;

  failNext(err: Error): void {
    this.failWith = err;
  }

  activeDeploy(appId: string): string {
    return this.active.get(appId) ?? '';
  }

  imageRef(app: ContainerApp, deployId: string): string {
    return `registry.cloudflare.com/fake/${app.script}:${deployId}`;
  }

  async build(job: RolloutJob): Promise<RolloutResult> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    for (const file of job.files) await file.read();
    this.builds.push(job);
    return { imageRef: this.imageRef(job.app, job.deployId) };
  }

  async rollout(job: RolloutJob, _imageRef: string): Promise<void> {
    this.rollouts.push(job);
    this.active.set(job.app.id, job.deployId);
  }

  async teardown(app: ContainerApp): Promise<void> {
    this.torndown.push(app.id);
    this.active.delete(app.id);
  }
}
