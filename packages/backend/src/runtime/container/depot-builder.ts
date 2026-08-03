// The Depot builder (the recommended build home): managed remote BuildKit, driven
// daemonless from the Railway control plane. It reuses the shared
// RegistryContainerBuilder spine (materialize, roll, teardown, exec discipline) and
// swaps the two Docker commands for one `depot build --push`, which streams the
// context to Depot's remote builders and pushes straight to registry.cloudflare.com
// — no local Docker daemon anywhere in the loop.
//
// Per report §5.3: ensure a Depot project (isolated layer cache), write the
// registry credentials where the `depot` CLI's docker-config provider reads them,
// createBuild() for a one-time build id + token, then exec `depot build --push`.
// Both the exec (build) and the Depot HTTP API (project + createBuild) are injected
// seams, so the whole sequence is unit-testable without a real Depot or Cloudflare
// account. This module reaches for node:fs and must never enter a Workers bundle.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeployCode, DeployErr } from '@280/contracts';
import type { RuntimeApp } from '../../seams.js';
import type { RolloutJob } from './container.js';
import {
  RegistryContainerBuilder,
  type RegistryBuilderConfig,
} from './registry-builder.js';

// DepotApi is the headless Depot control surface the builder needs: resolve a
// project (isolated builder + cache) and open one build for a one-time token. The
// default is HttpDepotApi against api.depot.dev with the org token; tests inject a
// fake. Exec (the actual `depot build`) stays on the RegistryContainerBuilder exec
// seam, so no builder logic reaches the network except through this interface.
export interface DepotApi {
  ensureProject(name: string): Promise<{ id: string }>;
  createBuild(projectId: string): Promise<{ buildId: string; buildToken: string }>;
}

export interface DepotBuilderConfig extends RegistryBuilderConfig {
  // depotToken is the Depot organization token (DEPOT_TOKEN) that authorizes
  // createBuild and, in turn, the per-build token the CLI uses.
  depotToken: string;
  // projectId pins every build to one Depot project ("base project" mode). When
  // unset, a per-app project is resolved via DepotApi.ensureProject so each app
  // gets an isolated layer cache. A configured project id skips the project API
  // entirely, which is the operationally simplest first cut.
  projectId?: string;
  api?: DepotApi;
  apiBaseUrl?: string; // default https://api.depot.dev
  fetch?: typeof fetch;
}

const DEPOT_API_BASE = 'https://api.depot.dev';
const DOCKER_CONFIG_DIR = '.docker';

export class DepotBuilder extends RegistryContainerBuilder {
  private readonly depotToken: string;
  private readonly configuredProjectId: string;
  private readonly api: DepotApi;
  // Per-app project ids resolved this process, so ensureProject is called once per
  // app rather than on every deploy.
  private readonly projectByApp = new Map<string, string>();

  constructor(cfg: DepotBuilderConfig) {
    super(cfg);
    this.depotToken = cfg.depotToken;
    this.configuredProjectId = cfg.projectId ?? '';
    this.api =
      cfg.api ??
      new HttpDepotApi({
        token: cfg.depotToken,
        baseUrl: cfg.apiBaseUrl ?? DEPOT_API_BASE,
        fetch: cfg.fetch,
      });
  }

  protected async buildAndPush(
    ctx: string,
    image: string,
    dockerfile: string,
    job: RolloutJob,
  ): Promise<void> {
    const dockerConfig = await this.writeRegistryCredentials(ctx);
    const projectId = await this.ensureProject(job.app);
    const build = await this.createBuild(projectId);
    await this.run(
      ctx,
      'depot',
      ['build', '--push', '-t', image, '-f', dockerfile, '.'],
      'build the image on Depot',
      {
        DEPOT_PROJECT_ID: projectId,
        DEPOT_BUILD_ID: build.buildId,
        DEPOT_TOKEN: build.buildToken,
        DOCKER_CONFIG: dockerConfig,
      },
    );
  }

  // writeRegistryCredentials writes the docker config.json the `depot` CLI reads as
  // its credentials provider. It goes in a per-build dir pointed at by DOCKER_CONFIG
  // (never the host's ~/.docker), so concurrent builds never race on one file and
  // the operator's own docker login is left untouched.
  private async writeRegistryCredentials(ctx: string): Promise<string> {
    const dir = join(ctx, DOCKER_CONFIG_DIR);
    await mkdir(dir, { recursive: true });
    const { username, password } = await this.registryCredentials();
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const config = { auths: { [this.registry]: { auth } } };
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    return dir;
  }

  private async ensureProject(app: RuntimeApp): Promise<string> {
    if (this.configuredProjectId !== '') return this.configuredProjectId;
    const cached = this.projectByApp.get(app.id);
    if (cached) return cached;
    const { id } = await this.api.ensureProject(`280-${app.id}`);
    this.projectByApp.set(app.id, id);
    return id;
  }

  private async createBuild(projectId: string): Promise<{ buildId: string; buildToken: string }> {
    try {
      return await this.api.createBuild(projectId);
    } catch (err) {
      // A Depot API failure (createBuild/ensureProject) is transient platform
      // infrastructure, not the app's build: keep it retryable so the activator
      // loop tries again rather than the agent editing a healthy Dockerfile.
      if (err instanceof DeployErr) throw err;
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'could not open a Depot build: ' + errText(err),
        retryable: true,
      });
    }
  }
}

interface HttpDepotApiConfig {
  token: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

// HttpDepotApi talks to Depot's Connect API over plain JSON POSTs with the org
// token. It implements createBuild (well-documented, the only call base-project
// mode needs); ensureProject is left to a future per-app-project provider and
// throws rather than pretend a project exists, so misconfiguration surfaces
// honestly instead of silently sharing one cache. Only exercised in the gated live
// proof — unit tests inject a fake DepotApi.
class HttpDepotApi implements DepotApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: HttpDepotApiConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  async ensureProject(_name: string): Promise<{ id: string }> {
    throw new DeployErr({
      code: DeployCode.Unavailable,
      message:
        'per-app Depot project provisioning is not configured: set a base DEPOT_PROJECT_ID, or inject a DepotApi with project support',
      retryable: false,
    });
  }

  async createBuild(projectId: string): Promise<{ buildId: string; buildToken: string }> {
    const res = await this.fetchImpl(this.base + '/depot.build.v1.BuildService/CreateBuild', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.cfg.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: `Depot createBuild failed (HTTP ${res.status}): ${text}`,
        retryable: true,
      });
    }
    const body = safeJson(text) as { buildId?: unknown; buildToken?: unknown };
    if (typeof body.buildId !== 'string' || typeof body.buildToken !== 'string') {
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'Depot createBuild returned no build id/token',
        retryable: true,
      });
    }
    return { buildId: body.buildId, buildToken: body.buildToken };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
