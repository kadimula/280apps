// The container runtime: the seam impl over a builder (FakeBuilder, no Docker).
// The concrete registry builders' command sequence and context materialization
// are proven in depot-builder.test.ts.

import { describe, it, expect } from 'vitest';
import { DeployErr, State, digestBytes, normalizeEgressPolicy, type Digest, type Manifest } from '@280/contracts';
import type { Activation, RuntimeApp, SecretDelivery } from '../../src/seams.js';
import { deliveryFailed } from '../../src/secret-delivery.js';
import { ContainerRuntime, FakeBuilder } from '../../src/runtime/container/index.js';
import { bodyOf, newPlatform, portFor, testManifest } from '../helpers/harness.js';

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

  it('carries the manifest egress policy into the rollout job, normalized', async () => {
    const builder = new FakeBuilder();
    const rt = new ContainerRuntime(builder);
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    // Deliberately un-normalized: mixed case, a stray un-credentialed allow entry,
    // and a credentialed host absent from allowedHosts. job() must normalize it.
    act.manifest.egress = {
      allowedHosts: ['Data.Example.com'],
      credentials: [{ host: 'API.Stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
    };
    await rt.activate(act);
    expect(builder.rollouts).toHaveLength(1);
    expect(builder.rollouts[0]!.egress).toEqual(normalizeEgressPolicy(act.manifest.egress));
    // Concretely: hosts lowercased, sorted, credential host folded into the allowlist.
    expect(builder.rollouts[0]!.egress).toEqual({
      allowedHosts: ['api.stripe.com', 'data.example.com'],
      credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
    });
  });

  it('defaults to an empty egress policy when the manifest declares none', async () => {
    const builder = new FakeBuilder();
    const rt = new ContainerRuntime(builder);
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    await rt.activate(act);
    expect(builder.rollouts[0]!.egress).toEqual({ allowedHosts: [], credentials: [] });
  });

  it('surfaces a builder failure as a DeployErr through the seam', async () => {
    const builder = new FakeBuilder();
    builder.failNext(new DeployErr({ code: 'unavailable', message: 'build broke', fix: 'fix it', retryable: false }));
    const rt = new ContainerRuntime(builder);
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    await expect(rt.activate(act)).rejects.toMatchObject({ code: 'unavailable', fix: 'fix it', retryable: false });
  });

  it('surfaces secret delivery failure as an activation failure', async () => {
    const builder = new FakeBuilder();
    const secrets: SecretDelivery = {
      rollout: async () => {
        throw deliveryFailed(['API_KEY']);
      },
      set: async () => {},
      delete: async () => {},
    };
    const rt = new ContainerRuntime(builder, secrets);
    const { act } = activation({ Dockerfile: 'FROM node:20' });
    act.manifest.secrets = ['API_KEY'];

    await expect(rt.activate(act)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('records a delivery failure as a failed deploy', async () => {
    const secrets: SecretDelivery = {
      rollout: async () => {
        throw deliveryFailed(['API_KEY']);
      },
      set: async () => {},
      delete: async () => {},
    };
    const runtime = new ContainerRuntime(new FakeBuilder(), secrets);
    const harness = await newPlatform({ runtime });
    try {
      const port = await portFor(harness);
      const { manifest, worker, digest } = testManifest();
      manifest.secrets = ['API_KEY'];
      const synced = await port.sync({
        identity: {
          appId: '',
          slug: 'delivery-failure',
          framework: 'next',
          gitRemote: '',
          clientRef: 'delivery-failure',
          forceNew: false,
        },
        manifest,
      });

      await harness.store.putAppSecret({
        appId: synced.app.id,
        name: 'API_KEY',
        envelope: '',
        setBy: 'owner@test',
        setAt: 1,
      });
      await port.putBlob(synced.app.id, digest, worker.byteLength, bodyOf(worker));

      const status = await port.status(synced.app.id, synced.deployId);
      expect(status.state).toBe(State.Failed);
      expect(status.failure?.message).toContain('API_KEY');
    } finally {
      await harness.cleanup();
    }
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
