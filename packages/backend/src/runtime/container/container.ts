import type {
  BuildSpec,
  ConfigEntry,
  EgressPolicy,
  RouteGate,
} from '@280/contracts';
import type { ContainerApp } from '../../seams.js';

export interface ContextFile {
  path: string;
  read(): Promise<Uint8Array>;
}

export interface ContainerDeployment {
  app: ContainerApp;
  deployId: string;
  build: BuildSpec;
  files: ContextFile[];
  runtime: {
    routes: RouteGate[];
    secrets: string[];
    egress: EgressPolicy;
    config: ConfigEntry[];
  };
}

export interface RolloutResult {
  imageRef: string;
}

export interface ContainerBuilder {
  imageRef(app: ContainerApp, deployId: string): string;
  build(deployment: ContainerDeployment): Promise<RolloutResult>;
  rollout(deployment: ContainerDeployment, imageRef: string, env: Record<string, string>): Promise<void>;
  teardown(app: ContainerApp): Promise<void>;
}

export class FakeBuilder implements ContainerBuilder {
  readonly builds: ContainerDeployment[] = [];
  readonly rollouts: Array<{ deployment: ContainerDeployment; env: Record<string, string> }> = [];
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

  async build(deployment: ContainerDeployment): Promise<RolloutResult> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    for (const file of deployment.files) await file.read();
    this.builds.push(deployment);
    return { imageRef: this.imageRef(deployment.app, deployment.deployId) };
  }

  async rollout(
    deployment: ContainerDeployment,
    _imageRef: string,
    env: Record<string, string>,
  ): Promise<void> {
    this.rollouts.push({ deployment, env });
    this.active.set(deployment.app.id, deployment.deployId);
  }

  async teardown(app: ContainerApp): Promise<void> {
    this.torndown.push(app.id);
    this.active.delete(app.id);
  }
}
