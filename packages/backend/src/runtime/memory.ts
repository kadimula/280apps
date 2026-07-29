// MemoryRuntime records activations instead of performing them.
// Spec: platform/internal/runtime/memory.go. Go is normative.
//
// It exists so the deploy seam's behavior can be tested without an account on
// anyone's infrastructure: conformance runs against it, and what it asserts
// (idempotency, resumption, atomicity of the serving flip) is control-plane
// behavior that must hold whatever the substrate is. The Cloudflare runtime is
// verified separately, against a mocked Cloudflare.

import type { Runtime, Activation, RuntimeApp, RuntimeResult } from '../seams.js';

export class MemoryRuntime implements Runtime {
  private readonly active = new Map<string, string>(); // app id -> deploy id
  private readonly stores = new Map<string, string>(); // app id -> store id
  private failErr: Error | null = null; // one-shot: next activation fails

  // failNext makes the next activation fail with err, simulating a substrate
  // that rejected the deploy.
  failNext(err: Error): void {
    this.failErr = err;
  }

  // activeDeploy reports which deploy an app is serving.
  activeDeploy(appId: string): string {
    return this.active.get(appId) ?? '';
  }

  async activate(act: Activation): Promise<RuntimeResult> {
    if (this.failErr) {
      const err = this.failErr;
      this.failErr = null;
      throw err;
    }
    // Read the worker the way a real runtime would, so a manifest naming a blob
    // nobody uploaded fails here rather than going live empty.
    await act.asset(act.manifest.worker.digest);

    const out: RuntimeResult = { storeId: '' };
    if (act.app.storeId === '') {
      let storeId = this.stores.get(act.app.id) ?? '';
      if (storeId === '') {
        storeId = 'store_' + act.app.id;
        this.stores.set(act.app.id, storeId);
      }
      out.storeId = storeId;
    }
    this.active.set(act.app.id, act.deployId);
    return out;
  }

  async delete(app: RuntimeApp): Promise<void> {
    this.active.delete(app.id);
    this.stores.delete(app.id);
  }
}
