// The self-hosted Docker builder (build-home decision A). It runs where Docker
// runs — a builder host the Workers control plane reaches over HTTP, or a node
// harness for the local proof — NEVER on the Workers control plane, which cannot
// run Docker. It materializes the uploaded build context, builds the image,
// pushes it to registry.cloudflare.com, and rolls the app's container application.
//
// Every external command goes through an injected exec, so the sequence and the
// materialized context are unit-testable without Docker or a Cloudflare account.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DeployCode, DeployErr } from '@280/contracts';
import type { RuntimeApp } from '../../seams.js';
import type { ContainerBuilder, RolloutJob, RolloutResult } from './container.js';

export interface ExecResult {
  code: number;
  output: string; // combined stdout + stderr
}

// ExecFn runs one command in cwd and resolves with its exit code and combined
// output. It never rejects on a non-zero exit; the builder inspects code.
export type ExecFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>;

export interface DockerBuilderConfig {
  accountId: string;
  apiToken: string;
  registry?: string; // default registry.cloudflare.com
  instanceType?: string; // default 'dev'
  maxInstances?: number; // default 1
  workdir?: string; // where contexts materialize; default os.tmpdir()
  exec?: ExecFn;
}

const DEFAULT_REGISTRY = 'registry.cloudflare.com';

export class DockerBuilder implements ContainerBuilder {
  private readonly registry: string;
  private readonly instanceType: string;
  private readonly maxInstances: number;
  private readonly workdir: string;
  private readonly exec: ExecFn;

  constructor(private readonly cfg: DockerBuilderConfig) {
    this.registry = cfg.registry ?? DEFAULT_REGISTRY;
    this.instanceType = cfg.instanceType ?? 'dev';
    this.maxInstances = cfg.maxInstances ?? 1;
    this.workdir = cfg.workdir ?? tmpdir();
    this.exec = cfg.exec ?? spawnExec;
  }

  imageRef(app: RuntimeApp, deployId: string): string {
    return `${this.registry}/${this.cfg.accountId}/${app.script}:${deployId}`;
  }

  async rollout(job: RolloutJob): Promise<RolloutResult> {
    const ctx = await mkdtemp(join(this.workdir, '280-ctx-'));
    try {
      await materialize(ctx, job.files);
      const image = this.imageRef(job.app, job.deployId);
      const dockerfile = job.build.dockerfile || 'Dockerfile';

      await this.run(ctx, 'docker', ['build', '-t', image, '-f', dockerfile, '.'], 'build the image');
      await this.login(ctx);
      await this.run(ctx, 'docker', ['push', image], 'push the image to the registry');
      // Create or roll the app's container application onto the new image. The
      // fronting/routing to <app>.280apps.run is the Phase-2 gateway's job; here
      // the application just has to exist on the new image, idempotently.
      await this.run(
        ctx,
        'wrangler',
        [
          'containers',
          'apply',
          '--name',
          job.app.script,
          '--image',
          image,
          '--instance-type',
          this.instanceType,
          '--max-instances',
          String(this.maxInstances),
        ],
        'roll the container application',
      );
      return { imageRef: image };
    } finally {
      await rm(ctx, { recursive: true, force: true });
    }
  }

  async teardown(app: RuntimeApp): Promise<void> {
    // Idempotent: a container application already gone is success. wrangler exits
    // non-zero for "not found", so a failed teardown is only reported when the
    // application is still there afterwards; here we treat any non-zero as
    // best-effort and let the alarm retry a genuine outage.
    const res = await this.exec('wrangler', ['containers', 'delete', app.script, '--force'], {
      cwd: this.workdir,
    });
    if (res.code !== 0 && !/not found|no container|does not exist/i.test(res.output)) {
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: `could not delete container application ${app.script}: ${tail(res.output)}`,
        retryable: true,
      });
    }
  }

  private async login(ctx: string): Promise<void> {
    const res = await this.exec(
      'docker',
      ['login', this.registry, '-u', this.cfg.accountId, '--password', this.cfg.apiToken],
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

  private async run(cwd: string, cmd: string, args: string[], what: string): Promise<void> {
    const res = await this.exec(cmd, args, { cwd });
    if (res.code === 0) return;
    // A docker/wrangler build failure is the app's own: surface the log tail and a
    // fix, non-retryable, so the agent repairs its Dockerfile/build rather than the
    // loop retrying identical bytes. Reached through activationFailure plumbing.
    throw new DeployErr({
      code: DeployCode.Unavailable,
      message: `failed to ${what}:\n${tail(res.output)}`,
      fix: 'fix the build error above, then run 280 push again',
      retryable: false,
    });
  }
}

// materialize writes the build context to dir, creating parent directories and
// refusing any path that escapes the context root (defence in depth: preflight
// already rejected these, but the builder never trusts the manifest with a raw
// filesystem write).
async function materialize(dir: string, files: RolloutJob['files']): Promise<void> {
  const root = resolve(dir);
  for (const f of files) {
    const abs = resolve(root, f.path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new DeployErr({
        code: DeployCode.PreflightRejected,
        message: `context path "${f.path}" escapes the build context`,
        fix: 'upgrade the 280 CLI, then run 280 push again',
      });
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, await f.read());
  }
}

function tail(s: string, n = 25): string {
  const lines = s.split('\n').filter((l) => l.trim() !== '');
  return (lines.length > n ? lines.slice(-n) : lines).join('\n');
}

// spawnExec is the production ExecFn: it runs the command and collects combined
// output. Kept out of the class so tests inject a fake without importing
// child_process. Imported lazily so this module loads under Workers type-checking
// (it is never actually invoked there — the control plane uses HttpBuilder).
const spawnExec: ExecFn = async (cmd, args, opts) => {
  const { spawn } = await import('node:child_process');
  return new Promise<ExecResult>((resolveExec) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));
    child.on('error', (e) => resolveExec({ code: 127, output: output + String(e) }));
    child.on('close', (code) => resolveExec({ code: code ?? 0, output }));
  });
};
