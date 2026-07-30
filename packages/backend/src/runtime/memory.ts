// MemoryRuntime records activations instead of performing them (Go is normative:
// memory.go), so the deploy seam's behavior can be tested without any real account.
// The Cloudflare runtime is verified separately, against a mocked Cloudflare.

import type { Runtime, Activation, RuntimeApp, RuntimeResult } from '../seams.js';

export class MemoryRuntime implements Runtime {
  private readonly active = new Map<string, string>(); // app id -> deploy id
  private readonly stores = new Map<string, string>(); // app id -> store id
  private failErr: Error | null = null; // one-shot: next activation fails

  // failNext makes the next activation fail with err, simulating a rejecting substrate.
  failNext(err: Error): void {
    this.failErr = err;
  }

  activeDeploy(appId: string): string {
    return this.active.get(appId) ?? '';
  }

  async activate(act: Activation): Promise<RuntimeResult> {
    if (this.failErr) {
      const err = this.failErr;
      this.failErr = null;
      throw err;
    }
    // Read the Dockerfile the way a real runtime would when it assembles the build
    // context, so a manifest naming a blob nobody uploaded fails here rather than
    // going live empty.
    const dockerfile = act.manifest.files.find((f) => f.path === act.manifest.build.dockerfile);
    if (dockerfile) await act.asset(dockerfile.digest);

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
