// HttpBuilder is the ContainerBuilder the Workers control plane uses: it ships the
// build context to the self-hosted Docker build host over HTTP and relays the
// outcome. It holds no Docker and no filesystem, so it loads and runs under the
// Workers runtime (the AppActivator Durable Object builds it); the host on the
// other end runs the real DockerBuilder.
//
// A build failure comes back as the seam's error shape (status + DeployError
// JSON) and is rethrown as a DeployErr, so a broken app build reaches the agent
// through the same activationFailure plumbing as any other activation failure.

import { DeployCode, DeployErr, type DeployError } from '@280/contracts';
import type { RuntimeApp } from '../../seams.js';
import type { ContainerBuilder, RolloutJob, RolloutResult } from './container.js';

export interface HttpBuilderConfig {
  // baseUrl is the self-hosted build host, e.g. https://builder.internal.280apps.
  baseUrl: string;
  // token authenticates the control plane to the build host (shared secret).
  token: string;
  fetch?: typeof fetch;
}

export class HttpBuilder implements ContainerBuilder {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: HttpBuilderConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  async rollout(job: RolloutJob): Promise<RolloutResult> {
    const form = new FormData();
    form.append(
      'job',
      JSON.stringify({ app: job.app, deployId: job.deployId, build: job.build }),
    );
    for (const f of job.files) {
      const bytes = await f.read();
      form.append('file', new Blob([bytes]), f.path);
    }
    const res = await this.send('/rollout', form);
    return { imageRef: String((res as { imageRef?: unknown }).imageRef ?? '') };
  }

  async teardown(app: RuntimeApp): Promise<void> {
    await this.send('/teardown', JSON.stringify({ app }), 'application/json');
  }

  private async send(path: string, body: BodyInit, contentType?: string): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + this.cfg.token };
    if (contentType) headers['Content-Type'] = contentType;
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.base + path, { method: 'POST', headers, body });
    } catch (err) {
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'build host unreachable: ' + (err instanceof Error ? err.message : String(err)),
        retryable: true,
      });
    }
    const text = await resp.text();
    if (resp.ok) return text === '' ? {} : safeJson(text);
    // The build host returns the seam error shape; rebuild the throwable so its
    // code/fix/retryable reach the agent intact.
    const e = safeJson(text) as Partial<DeployError>;
    throw new DeployErr({
      code: typeof e.code === 'string' ? e.code : DeployCode.Unavailable,
      message: typeof e.message === 'string' ? e.message : `build host returned HTTP ${resp.status}`,
      fix: typeof e.fix === 'string' ? e.fix : '',
      retryable: e.retryable === true,
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
