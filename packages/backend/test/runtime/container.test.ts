// The container runtime: the seam impl over a builder (FakeBuilder, no Docker),
// and the self-hosted DockerBuilder driven with an injected exec and a real temp
// filesystem so its command sequence and context materialization are proven
// without Docker or a Cloudflare account.

import { describe, it, expect } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployErr, digestBytes, type Digest, type Manifest } from '@280/contracts';
import type { Activation, RuntimeApp } from '../../src/seams.js';
import { ContainerRuntime, FakeBuilder } from '../../src/runtime/container/index.js';
import { DockerBuilder, type ExecFn } from '../../src/runtime/container/docker-builder.js';

function app(over: Partial<RuntimeApp> = {}): RuntimeApp {
  return { id: 'app_1', slug: 'demo', framework: 'next', script: 'demo-abc', salt: 's', storeId: '', ...over };
}

function activation(files: Record<string, string>): { act: Activation; blobs: Map<Digest, Uint8Array> } {
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
    blobs,
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

describe('ContainerRuntime (over a builder)', () => {
  it('rolls out the whole context and reports no store id', async () => {
    const builder = new FakeBuilder();
    const rt = new ContainerRuntime(builder);
    const { act } = activation({ Dockerfile: 'FROM node:20', 'server.js': 'listen()' });
    const res = await rt.activate(act);
    expect(res.storeId).toBe('');
    expect(builder.rollouts).toHaveLength(1);
    expect(builder.rollouts[0]!.files.map((f) => f.path).sort()).toEqual(['Dockerfile', 'server.js']);
    expect(builder.rollouts[0]!.build.port).toBe(8080);
  });

  it('surfaces a builder failure as a DeployErr through the seam', async () => {
    const builder = new FakeBuilder();
    builder.failNext(new DeployErr({ code: 'unavailable', message: 'build broke', fix: 'fix it', retryable: false }));
    const rt = new ContainerRuntime(builder);
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    await expect(rt.activate(act)).rejects.toMatchObject({ code: 'unavailable', fix: 'fix it', retryable: false });
  });

  it('fails when the context names a blob nobody uploaded', async () => {
    const builder = new FakeBuilder();
    const rt = new ContainerRuntime(builder);
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    act.asset = async () => {
      throw new Error('no blob');
    };
    await expect(rt.activate(act)).rejects.toBeInstanceOf(DeployErr);
  });

  it('delete forwards to the builder teardown', async () => {
    const builder = new FakeBuilder();
    const rt = new ContainerRuntime(builder);
    await rt.delete(app({ id: 'app_9' }));
    expect(builder.torndown).toEqual(['app_9']);
  });
});

describe('DockerBuilder (injected exec)', () => {
  function recordingExec(codes: Record<string, number> = {}): { exec: ExecFn; calls: string[][] } {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const code = codes[cmd] ?? 0;
      return { code, output: `${cmd} output` };
    };
    return { exec, calls };
  }

  // credsFetch fakes the Cloudflare registry-credentials endpoint the login step
  // exchanges the API token at; the registry never accepts the raw token.
  function credsFetch(): typeof fetch {
    return (async (url: unknown) => {
      if (String(url).includes('/credentials')) {
        return new Response(JSON.stringify({ success: true, result: { username: 'v1', password: 'reg-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('unexpected fetch: ' + String(url));
    }) as unknown as typeof fetch;
  }

  it('materializes the context, then builds, logs in, pushes, and rolls', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec, calls } = recordingExec();
    const builder = new DockerBuilder({ accountId: 'acct1', apiToken: 'tok', workdir, exec, fetch: credsFetch() });
    const { act } = activation({ Dockerfile: 'FROM node:20', 'app/page.tsx': 'export default 1' });

    const res = await builder.rollout({
      app: act.app,
      deployId: act.deployId,
      build: act.manifest.build,
      files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
      policy: { access: 'invited', roles: [], routes: [], secrets: [] },
    });

    expect(res.imageRef).toBe('registry.cloudflare.com/acct1/demo-abc:dep_1');
    const cmds = calls.map((c) => `${c[0]} ${c[1]}`);
    // The roll is `wrangler deploy` (report §7: `wrangler containers apply` never
    // existed and no-oped), not `wrangler containers`.
    expect(cmds).toEqual(['docker build', 'docker login', 'docker push', 'wrangler deploy']);
    const rollCall = calls.find((c) => c[0] === 'wrangler')!;
    expect(rollCall).toEqual(['wrangler', 'deploy', '--config', 'wrangler.roll.json', '--containers-rollout', 'immediate']);
    // The build ran in the materialized context, with the app's file present.
    const buildCall = calls.find((c) => c[0] === 'docker' && c[1] === 'build')!;
    expect(buildCall).toContain('registry.cloudflare.com/acct1/demo-abc:dep_1');
    await rm(workdir, { recursive: true, force: true });
  });

  it('rolls with a generated wrangler config that pins the pre-built registry image', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    let rollConfig: Record<string, unknown> = {};
    // Read the generated roll config during `wrangler deploy`, before rollout's
    // finally removes the context, so no local Docker build happens on the roll.
    const exec: ExecFn = async (cmd, args, opts) => {
      if (cmd === 'wrangler' && args[0] === 'deploy') {
        rollConfig = JSON.parse(await readFile(join(opts.cwd, 'wrangler.roll.json'), 'utf8'));
      }
      return { code: 0, output: '' };
    };
    const builder = new DockerBuilder({ accountId: 'acct1', apiToken: 'tok', workdir, workerEntry: 'harness.js', exec, fetch: credsFetch() });
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    await builder.rollout({
      app: act.app,
      deployId: act.deployId,
      build: act.manifest.build,
      files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
      policy: { access: 'invited', roles: [], routes: [], secrets: [] },
    });
    expect(rollConfig.name).toBe('demo-abc');
    expect(rollConfig.main).toBe('harness.js');
    expect(rollConfig.containers).toEqual([
      {
        class_name: 'App280Container',
        image: 'registry.cloudflare.com/acct1/demo-abc:dep_1',
        instance_type: 'dev',
        max_instances: 1,
      },
    ]);
    // The app Worker gets its own route and the GATEWAY binding to the central
    // gateway's GatewayRPC (mint/jwks) — the container-only front door.
    expect(rollConfig.routes).toEqual([{ pattern: 'demo-abc.280apps.run/*', zone_name: '280apps.run' }]);
    expect(rollConfig.services).toEqual([{ binding: 'GATEWAY', service: '280-gateway', entrypoint: 'GatewayRPC' }]);
    const vars = rollConfig.vars as Record<string, string>;
    expect(vars.TWO80_APP_ID).toBe('app_1');
    expect(vars.TWO80_SCRIPT).toBe('demo-abc');
    expect(vars.TWO80_APP_HOST_SUFFIX).toBe('');
    expect(vars.TWO80_APP_DOMAIN).toBe('280apps.run');
    expect(vars.TWO80_ID_ISSUER).toBe('https://auth.280apps.run');
    expect(vars.TWO80_ID_SKEW_SECS).toBe('5');
    await rm(workdir, { recursive: true, force: true });
  });

  it('bakes the dev serving suffix and the app route policy into the roll config', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    let rollConfig: Record<string, unknown> = {};
    const exec: ExecFn = async (cmd, args, opts) => {
      if (cmd === 'wrangler' && args[0] === 'deploy') {
        rollConfig = JSON.parse(await readFile(join(opts.cwd, 'wrangler.roll.json'), 'utf8'));
      }
      return { code: 0, output: '' };
    };
    const builder = new DockerBuilder({
      accountId: 'acct1',
      apiToken: 'tok',
      workdir,
      workerEntry: 'harness.js',
      hostSuffix: '-development',
      exec,
      fetch: credsFetch(),
    });
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    const policy = { access: 'invited', roles: ['manager'], routes: [{ path: '/admin/*', appRole: 'admin', role: '' }], secrets: [] };
    await builder.rollout({
      app: act.app,
      deployId: act.deployId,
      build: act.manifest.build,
      files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
      policy,
    });
    // Dev host + service both carry the -development suffix; the issuer follows.
    expect(rollConfig.routes).toEqual([{ pattern: 'demo-abc-development.280apps.run/*', zone_name: '280apps.run' }]);
    expect(rollConfig.services).toEqual([
      { binding: 'GATEWAY', service: '280-gateway-development', entrypoint: 'GatewayRPC' },
    ]);
    const vars = rollConfig.vars as Record<string, string>;
    expect(vars.TWO80_APP_HOST_SUFFIX).toBe('-development');
    expect(vars.TWO80_ID_ISSUER).toBe('https://auth-development.280apps.run');
    // The whole enforced policy is baked verbatim so the middleware can route-gate locally.
    expect(JSON.parse(vars.TWO80_ROUTE_POLICY)).toEqual(policy);
    await rm(workdir, { recursive: true, force: true });
  });

  it('surfaces a build failure as a non-retryable fix', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    const { exec } = recordingExec({ docker: 1 }); // docker build exits non-zero
    const builder = new DockerBuilder({ accountId: 'a', apiToken: 't', workdir, exec, fetch: credsFetch() });
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    await expect(
      builder.rollout({
        app: act.app,
        deployId: act.deployId,
        build: act.manifest.build,
        files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
        policy: { access: 'invited', roles: [], routes: [], secrets: [] },
      }),
    ).rejects.toMatchObject({ retryable: false, fix: expect.stringContaining('280 push') });
    await rm(workdir, { recursive: true, force: true });
  });

  it('teardown treats a missing container application as success', async () => {
    const notFound: ExecFn = async () => ({ code: 1, output: 'container not found' });
    const builder = new DockerBuilder({ accountId: 'a', apiToken: 't', exec: notFound });
    await expect(builder.teardown(app())).resolves.toBeUndefined();
  });

  it('materializes the whole context under the build root before building', async () => {
    const workdir = mkdtempSync(join(tmpdir(), '280-wd-'));
    let seen: Record<string, string> = {};
    // Read the materialized context during `docker build`, before rollout's finally
    // removes it, so the assertion observes real files on disk.
    const exec: ExecFn = async (cmd, args, opts) => {
      if (cmd === 'docker' && args[0] === 'build') {
        seen = {
          Dockerfile: await readFile(join(opts.cwd, 'Dockerfile'), 'utf8'),
          nested: await readFile(join(opts.cwd, 'src/index.ts'), 'utf8'),
        };
        expect(opts.cwd.startsWith(workdir)).toBe(true);
      }
      return { code: 0, output: '' };
    };
    const builder = new DockerBuilder({ accountId: 'a', apiToken: 't', workdir, exec, fetch: credsFetch() });
    const { act } = activation({ Dockerfile: 'FROM node:20', 'src/index.ts': 'export const x = 1' });
    await builder.rollout({
      app: act.app,
      deployId: act.deployId,
      build: act.manifest.build,
      files: act.manifest.files.map((f) => ({ path: f.path, read: () => act.asset(f.digest) })),
      policy: { access: 'invited', roles: [], routes: [], secrets: [] },
    });
    expect(seen).toEqual({ Dockerfile: 'FROM node:20', nested: 'export const x = 1' });
    await rm(workdir, { recursive: true, force: true });
  });
});
