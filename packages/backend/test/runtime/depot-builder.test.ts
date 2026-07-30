// DepotBuilder driven with an injected exec, a fake Depot API, and a real temp
// filesystem, so its command sequence, the registry credentials it writes, the
// build env it passes, and the (shared, fixed) wrangler roll are proven without a
// Depot org, Docker, or a Cloudflare account.

import { describe, it, expect } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployErr, digestBytes, type Digest, type Manifest } from '@280/contracts';
import type { Activation, RuntimeApp } from '../../src/seams.js';
import { DepotBuilder, type DepotApi } from '../../src/runtime/container/depot-builder.js';
import type { ExecFn } from '../../src/runtime/container/registry-builder.js';

function app(over: Partial<RuntimeApp> = {}): RuntimeApp {
  return { id: 'app_1', slug: 'demo', framework: 'next', script: 'demo-abc', salt: 's', storeId: '', ...over };
}

function activation(files: Record<string, string>): { act: Activation } {
  const blobs = new Map<Digest, Uint8Array>();
  const infos = Object.entries(files).map(([path, body]) => {
    const b = new TextEncoder().encode(body);
    const d = digestBytes(b);
    blobs.set(d, b);
    return { path, digest: d, size: b.length };
  });
  const manifest: Manifest = {
    kind: 'container',
    build: { builder: 'next', dockerfile: 'Dockerfile', port: 8080 },
    files: infos,
  };
  return {
    act: {
      app: app(),
      deployId: 'dep_1',
      manifest,
      asset: async (d: Digest) => {
        const b = blobs.get(d);
        if (!b) throw new Error('no blob ' + d);
        return b;
      },
    },
  };
}

function rolloutOf(act: Activation) {
  return {
    app: act.app,
    deployId: act.deployId,
    build: act.manifest.build,
    files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
  };
}

type Call = { cmd: string; args: string[]; cwd: string; env?: Record<string, string> };

function recordingExec(codes: Record<string, number> = {}): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    return { code: codes[cmd] ?? 0, output: `${cmd} output` };
  };
  return { exec, calls };
}

function fakeApi(over: Partial<DepotApi> = {}): { api: DepotApi; projects: string[]; builds: string[] } {
  const projects: string[] = [];
  const builds: string[] = [];
  const api: DepotApi = {
    ensureProject: async (name) => {
      projects.push(name);
      return { id: 'proj_for_' + name };
    },
    createBuild: async (projectId) => {
      builds.push(projectId);
      return { buildId: 'build_1', buildToken: 'btok_1' };
    },
    ...over,
  };
  return { api, projects, builds };
}

describe('DepotBuilder (injected exec + fake Depot API)', () => {
  it('writes registry creds, opens a build, and runs one `depot build --push`', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec, calls } = recordingExec();
    const { api, builds } = fakeApi();
    const builder = new DepotBuilder({
      accountId: 'acct1',
      apiToken: 'cf-tok',
      depotToken: 'depot-org-tok',
      projectId: 'proj_base',
      workerEntry: 'harness.js',
      workdir,
      exec,
      api,
    });

    const res = await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act));

    expect(res.imageRef).toBe('registry.cloudflare.com/acct1/demo-abc:dep_1');
    // Exactly one build command (no docker build/push), then the wrangler roll.
    const seq = calls.map((c) => `${c.cmd} ${c.args[0]}`);
    expect(seq).toEqual(['depot build', 'wrangler deploy']);

    const depot = calls.find((c) => c.cmd === 'depot')!;
    expect(depot.args).toEqual(['build', '--push', '-t', 'registry.cloudflare.com/acct1/demo-abc:dep_1', '-f', 'Dockerfile', '.']);
    expect(depot.env).toMatchObject({
      DEPOT_PROJECT_ID: 'proj_base',
      DEPOT_BUILD_ID: 'build_1',
      DEPOT_TOKEN: 'btok_1',
    });
    // The configured base project is used verbatim; createBuild ran against it.
    expect(builds).toEqual(['proj_base']);
    await rm(workdir, { recursive: true, force: true });
  });

  it('writes the docker config.json the depot CLI reads, in a per-build DOCKER_CONFIG dir', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    let seenAuth = '';
    let seenDockerConfig = '';
    const exec: ExecFn = async (cmd, args, opts) => {
      if (cmd === 'depot') {
        seenDockerConfig = opts.env?.DOCKER_CONFIG ?? '';
        const cfg = JSON.parse(await readFile(join(seenDockerConfig, 'config.json'), 'utf8'));
        seenAuth = cfg.auths['registry.cloudflare.com'].auth;
      }
      return { code: 0, output: '' };
    };
    const { api } = fakeApi();
    const builder = new DepotBuilder({
      accountId: 'acct1',
      apiToken: 'cf-tok',
      depotToken: 'd',
      projectId: 'p',
      workdir,
      exec,
      api,
    });
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act));

    // Basic-auth pair is <accountId>:<apiToken>, base64-encoded; never the host ~/.docker.
    expect(Buffer.from(seenAuth, 'base64').toString()).toBe('acct1:cf-tok');
    expect(seenDockerConfig.startsWith(workdir)).toBe(true);
    await rm(workdir, { recursive: true, force: true });
  });

  it('resolves a per-app Depot project when no base project id is configured', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec, calls } = recordingExec();
    const { api, projects, builds } = fakeApi();
    const builder = new DepotBuilder({
      accountId: 'a',
      apiToken: 't',
      depotToken: 'd',
      workdir,
      exec,
      api,
    });
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act));
    // A project was ensured for this app, and the build ran against it.
    expect(projects).toEqual(['280-app_1']);
    expect(builds).toEqual(['proj_for_280-app_1']);
    const depot = calls.find((c) => c.cmd === 'depot')!;
    expect(depot.env?.DEPOT_PROJECT_ID).toBe('proj_for_280-app_1');
    await rm(workdir, { recursive: true, force: true });
  });

  it('ensures a project once per app across repeated deploys', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec } = recordingExec();
    const { api, projects } = fakeApi();
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', workdir, exec, api });
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act));
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:22' }).act));
    expect(projects).toEqual(['280-app_1']);
    await rm(workdir, { recursive: true, force: true });
  });

  it('surfaces a depot build failure as a non-retryable fix', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec } = recordingExec({ depot: 1 }); // depot build exits non-zero
    const { api } = fakeApi();
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', projectId: 'p', workdir, exec, api });
    await expect(
      builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act)),
    ).rejects.toMatchObject({ retryable: false, fix: expect.stringContaining('280 push') });
    await rm(workdir, { recursive: true, force: true });
  });

  it('surfaces a Depot API failure as retryable, and never runs the build', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec, calls } = recordingExec();
    const { api } = fakeApi({
      createBuild: async () => {
        throw new Error('depot 503');
      },
    });
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', projectId: 'p', workdir, exec, api });
    await expect(
      builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act)),
    ).rejects.toMatchObject({ retryable: true });
    expect(calls.find((c) => c.cmd === 'depot')).toBeUndefined();
    await rm(workdir, { recursive: true, force: true });
  });

  it('rolls with the shared fixed wrangler deploy path (no `containers apply`, no local build)', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    let rollConfig: Record<string, unknown> = {};
    const exec: ExecFn = async (cmd, args, opts) => {
      if (cmd === 'wrangler' && args[0] === 'deploy') {
        rollConfig = JSON.parse(await readFile(join(opts.cwd, 'wrangler.roll.json'), 'utf8'));
      }
      return { code: 0, output: '' };
    };
    const { api } = fakeApi();
    const builder = new DepotBuilder({
      accountId: 'acct1',
      apiToken: 't',
      depotToken: 'd',
      projectId: 'p',
      workerEntry: 'harness.js',
      workdir,
      exec,
      api,
    });
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act));
    expect(rollConfig.containers).toEqual([
      { class_name: 'App280Container', image: 'registry.cloudflare.com/acct1/demo-abc:dep_1', instance_type: 'dev', max_instances: 1 },
    ]);
    await rm(workdir, { recursive: true, force: true });
  });

  it('teardown treats a missing container application as success', async () => {
    const notFound: ExecFn = async () => ({ code: 1, output: 'container not found' });
    const { api } = fakeApi();
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', projectId: 'p', exec: notFound, api });
    await expect(builder.teardown(app())).resolves.toBeUndefined();
  });

  it('teardown surfaces a genuine failure as retryable', async () => {
    const boom: ExecFn = async () => ({ code: 1, output: 'network unreachable' });
    const { api } = fakeApi();
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', projectId: 'p', exec: boom, api });
    await expect(builder.teardown(app())).rejects.toBeInstanceOf(DeployErr);
  });
});
