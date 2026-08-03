// The container runtime: the seam impl over a builder (FakeBuilder, no Docker).
// The concrete registry builders' command sequence and context materialization
// are proven in depot-builder.test.ts.

import { describe, it, expect } from 'vitest';
import { DeployErr, digestBytes, type Digest, type Manifest } from '@280/contracts';
import type { Activation, RuntimeApp } from '../../src/seams.js';
import { ContainerRuntime, FakeBuilder } from '../../src/runtime/container/index.js';

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
