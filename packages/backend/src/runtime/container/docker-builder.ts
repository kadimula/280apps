// The self-hosted Docker builder (build-home option A). It runs where Docker runs
// — a builder host or a node harness — NEVER on a Workers control plane, which
// cannot run Docker. It reuses the shared RegistryContainerBuilder spine
// (materialize, roll, teardown, exec discipline) and supplies only the build step:
// `docker build`, `docker login`, `docker push`.
//
// It is kept as the self-hosted-BuildKit escape hatch; the recommended build home
// is DepotBuilder (daemonless remote BuildKit). Both share this module's base so a
// fix to the roll or teardown lands for both at once.

import { DeployCode, DeployErr } from '@280/contracts';
import type { RolloutJob } from './container.js';
import {
  RegistryContainerBuilder,
  tail,
  type ExecFn,
  type ExecResult,
  type RegistryBuilderConfig,
} from './registry-builder.js';

export type { ExecFn, ExecResult };

export type DockerBuilderConfig = RegistryBuilderConfig;

export class DockerBuilder extends RegistryContainerBuilder {
  protected async buildAndPush(
    ctx: string,
    image: string,
    dockerfile: string,
    _job: RolloutJob,
  ): Promise<void> {
    await this.run(ctx, 'docker', ['build', '-t', image, '-f', dockerfile, '.'], 'build the image');
    await this.login(ctx);
    await this.run(ctx, 'docker', ['push', image], 'push the image to the registry');
  }

  private async login(ctx: string): Promise<void> {
    const { username, password } = await this.registryCredentials();
    const res = await this.exec(
      'docker',
      ['login', this.registry, '-u', username, '--password', password],
      { cwd: ctx },
    );
    if (res.code !== 0) {
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'could not authenticate to the container registry: ' + tail(res.output),
        retryable: true,
      });
    }
  }
}
