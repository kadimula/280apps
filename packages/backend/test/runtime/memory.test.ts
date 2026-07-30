// MemoryRuntime tests. Spec: platform/internal/runtime/memory.go.

import { describe, it, expect } from 'vitest';
import { digestBytes, MANIFEST_KIND_CONTAINER, type Manifest, type Digest } from '@280/contracts';
import type { Activation, RuntimeApp } from '../../src/seams.js';
import { MemoryRuntime } from '../../src/runtime/memory.js';

function activation(opts: { appId?: string; deployId?: string; storeId?: string }): Activation {
  const worker = new TextEncoder().encode('FROM scratch\n');
  const blobs = new Map<Digest, Uint8Array>([[digestBytes(worker), worker]]);
  const m: Manifest = {
    kind: MANIFEST_KIND_CONTAINER,
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest: digestBytes(worker), size: worker.length }],
  };
  const app: RuntimeApp = {
    id: opts.appId ?? 'app_1',
    slug: 'demo',
    framework: 'next',
    script: 'demo-abc',
    salt: 'salt',
    storeId: opts.storeId ?? '',
  };
  return {
    app,
    deployId: opts.deployId ?? 'dep_1',
    manifest: m,
    asset: async (d: Digest): Promise<Uint8Array> => {
      const b = blobs.get(d);
      if (!b) throw new Error('no blob ' + d);
      return b;
    },
  };
}

describe('MemoryRuntime', () => {
  it('creates a store on first activation and records the serving deploy', async () => {
    const rt = new MemoryRuntime();
    const res = await rt.activate(activation({ storeId: '' }));
    expect(res.storeId).toBe('store_app_1');
    expect(rt.activeDeploy('app_1')).toBe('dep_1');
  });

  it('is stable: the same app keeps its store id across activations', async () => {
    const rt = new MemoryRuntime();
    const first = await rt.activate(activation({ storeId: '' }));
    // already provisioned, so it reports empty (= unchanged)
    const second = await rt.activate(activation({ storeId: first.storeId, deployId: 'dep_2' }));
    expect(second.storeId).toBe('');
    expect(rt.activeDeploy('app_1')).toBe('dep_2');
  });

  it('fails the next activation once when armed', async () => {
    const rt = new MemoryRuntime();
    rt.failNext(new Error('substrate rejected'));
    await expect(rt.activate(activation({}))).rejects.toThrow('substrate rejected');
    // one-shot: the following activation succeeds.
    await expect(rt.activate(activation({}))).resolves.toBeDefined();
  });

  it('rejects a manifest whose Dockerfile blob was never uploaded', async () => {
    const rt = new MemoryRuntime();
    const act = activation({});
    act.asset = async (): Promise<Uint8Array> => {
      throw new Error('no blob');
    };
    await expect(rt.activate(act)).rejects.toThrow('no blob');
  });

  it('delete forgets the app and its store', async () => {
    const rt = new MemoryRuntime();
    await rt.activate(activation({ storeId: '' }));
    await rt.delete({
      id: 'app_1',
      slug: 'demo',
      framework: 'next',
      script: 'demo-abc',
      salt: 'salt',
      storeId: 'store_app_1',
    });
    expect(rt.activeDeploy('app_1')).toBe('');
    // a re-activation provisions a fresh store, proving the old one was dropped.
    const res = await rt.activate(activation({ storeId: '' }));
    expect(res.storeId).toBe('store_app_1');
  });
});
