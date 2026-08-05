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

function rolloutOf(act: Activation, over: { policy?: Record<string, unknown> } = {}) {
  return {
    app: act.app,
    deployId: act.deployId,
    build: act.manifest.build,
    files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
    policy: over.policy ?? { access: 'invited', roles: [], routes: [], secrets: [] },
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

// credsFetch fakes the Cloudflare registry-credentials endpoint: it returns the
// minted (username, password) the registry actually accepts, never the raw token.
function credsFetch(username = 'v1', password = 'reg-jwt'): typeof fetch {
  return (async (url: unknown) => {
    if (String(url).includes('/credentials')) {
      return new Response(JSON.stringify({ success: true, result: { username, password } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected fetch: ' + String(url));
  }) as unknown as typeof fetch;
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
      fetch: credsFetch(),
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

  it('mints registry creds from the CF API and writes them to the per-build DOCKER_CONFIG dir', async () => {
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
    let credUrl = '';
    let credAuthHeader = '';
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      credUrl = String(url);
      credAuthHeader = String((init?.headers as Record<string, string>)?.authorization ?? '');
      return new Response(JSON.stringify({ success: true, result: { username: 'v1', password: 'reg-jwt' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { api } = fakeApi();
    const builder = new DepotBuilder({
      accountId: 'acct1',
      apiToken: 'cf-tok',
      depotToken: 'd',
      projectId: 'p',
      workdir,
      exec,
      api,
      fetch: fetchImpl,
    });
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act));

    // The token is exchanged for scoped registry creds; the raw token is never the password.
    expect(credUrl).toContain('/accounts/acct1/containers/registries/registry.cloudflare.com/credentials');
    expect(credAuthHeader).toBe('Bearer cf-tok');
    expect(Buffer.from(seenAuth, 'base64').toString()).toBe('v1:reg-jwt');
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
      fetch: credsFetch(),
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
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', workdir, exec, api, fetch: credsFetch() });
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act));
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:22' }).act));
    expect(projects).toEqual(['280-app_1']);
    await rm(workdir, { recursive: true, force: true });
  });

  it('surfaces a depot build failure as a non-retryable fix', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec } = recordingExec({ depot: 1 }); // depot build exits non-zero
    const { api } = fakeApi();
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', projectId: 'p', workdir, exec, api, fetch: credsFetch() });
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
    const builder = new DepotBuilder({ accountId: 'a', apiToken: 't', depotToken: 'd', projectId: 'p', workdir, exec, api, fetch: credsFetch() });
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
      fetch: credsFetch(),
    });
    const policy = { access: 'public', roles: [], routes: [{ path: '/reports/*', appRole: '', role: 'analyst' }], secrets: ['API_KEY'] };
    await builder.rollout(rolloutOf(activation({ Dockerfile: 'FROM node:20' }).act, { policy }));
    expect(rollConfig.containers).toEqual([
      { class_name: 'App280Container', image: 'registry.cloudflare.com/acct1/demo-abc:dep_1', instance_type: 'dev', max_instances: 1 },
    ]);
    // Depot shares the same rollConfig spine: route + GATEWAY binding + baked policy.
    expect(rollConfig.routes).toEqual([{ pattern: 'demo-abc.280apps.run/*', zone_name: '280apps.run' }]);
    expect(rollConfig.services).toEqual([{ binding: 'GATEWAY', service: '280-gateway', entrypoint: 'GatewayRPC' }]);
    expect(JSON.parse((rollConfig.vars as Record<string, string>).TWO80_ROUTE_POLICY)).toEqual(policy);
    expect((rollConfig.vars as Record<string, string>).TWO80_FRAME_ANCESTORS).toBe('https://console.280apps.com');
    await rm(workdir, { recursive: true, force: true });
  });

  it('teardown deletes the app worker by name: wrangler delete <script> --force', async () => {
    const { exec, calls } = recordingExec();
    const { api } = fakeApi();
    const builder = new DepotBuilder({ accountId: 'acct1', apiToken: 'tok1', depotToken: 'd', projectId: 'p', exec, api });
    await builder.teardown(app({ script: 'demo-abc' }));
    const del = calls.find((c) => c.cmd === 'wrangler');
    // Not `containers delete <id>` (which rejects --force and needs a container id) —
    // the roll deploys a Worker named <script>, so teardown deletes that Worker.
    expect(del?.args).toEqual(['delete', 'demo-abc', '--force']);
    expect(del?.env).toMatchObject({ CLOUDFLARE_API_TOKEN: 'tok1', CLOUDFLARE_ACCOUNT_ID: 'acct1' });
  });

  it('teardown treats a missing app worker as success', async () => {
    const notFound: ExecFn = async () => ({ code: 1, output: 'Workers Script Not Found [code: 10007]' });
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
