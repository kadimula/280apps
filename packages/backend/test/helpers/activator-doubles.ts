// Test doubles for the activation suites (node ActivatorCore and Miniflare
// AppActivator DO): a store that logs its transition calls in order, and a
// runtime whose activations can be made to fail N times or block on a gate. Pure
// JS, so both node and workerd can import them.

import type { DeployError } from '@280/contracts';
import { MemoryStore } from './memory-store.js';
import type { Activation, Runtime, RuntimeApp, RuntimeResult } from '../../src/seams.js';

// records the order of deploy-transition calls, so a test can assert e.g. that
// the store id is persisted before the deploy is marked live.
export class InstrumentedStore extends MemoryStore {
  readonly calls: string[] = [];

  override async claimActivation(appId: string, deployId: string): Promise<boolean> {
    const won = await super.claimActivation(appId, deployId);
    this.calls.push(`claim:${won}`);
    return won;
  }

  override async setStoreId(appId: string, storeId: string): Promise<void> {
    this.calls.push('setStoreId');
    await super.setStoreId(appId, storeId);
  }

  override async finishLive(appId: string, deployId: string): Promise<void> {
    this.calls.push('finishLive');
    await super.finishLive(appId, deployId);
  }

  override async finishFailed(appId: string, deployId: string, failure: DeployError | null): Promise<void> {
    this.calls.push('finishFailed');
    await super.finishFailed(appId, deployId, failure);
  }

  claims(): string[] {
    return this.calls.filter((c) => c.startsWith('claim:'));
  }

  claimCount(): number {
    return this.claims().length;
  }
}

// A controllable runtime: it can be told to fail its next N activations (a
// substrate that keeps rejecting) and to block each activation on a manually
// released gate (to hold one mid-flight while a delete is attempted). It records
// activations and deletes in order.
export class TestRuntime implements Runtime {
  activations = 0;
  readonly order: string[] = [];
  readonly deleted: string[] = [];
  private readonly active = new Map<string, string>();
  private readonly stores = new Map<string, string>();
  private failUntil = 0; // fail while activations <= failUntil
  private deleteError: Error | null = null;
  private gate: { promise: Promise<void>; release: () => void } | null = null;

  // the next n activations throw before doing any work.
  failNextN(n: number): void {
    this.failUntil = this.activations + n;
  }

  // delete throws, simulating a substrate that would not let go of the script.
  failDeleteWith(err: Error): void {
    this.deleteError = err;
  }

  // holds every subsequent activation after it records its start, until
  // releaseGate; used to keep an activation mid-flight.
  openGate(): void {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    this.gate = { promise, release };
  }

  releaseGate(): void {
    this.gate?.release();
    this.gate = null;
  }

  activeDeploy(appId: string): string {
    return this.active.get(appId) ?? '';
  }

  async activate(act: Activation): Promise<RuntimeResult> {
    this.activations++;
    this.order.push(`activate:start:${act.deployId}`);
    const shouldFail = this.activations <= this.failUntil;
    if (this.gate) await this.gate.promise;
    if (shouldFail) {
      this.order.push(`activate:fail:${act.deployId}`);
      throw new Error('substrate rejected the deploy');
    }
    // Read the Dockerfile the way a real runtime would, so a missing blob fails here.
    const df = act.manifest.files.find((f) => f.path === act.manifest.build.dockerfile);
    if (df) await act.asset(df.digest);
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
    this.order.push(`activate:done:${act.deployId}`);
    return out;
  }

  async delete(app: RuntimeApp): Promise<void> {
    if (this.deleteError) {
      this.order.push(`delete:fail:${app.id}`);
      throw this.deleteError;
    }
    this.order.push(`delete:${app.id}`);
    this.deleted.push(app.id);
    this.active.delete(app.id);
    this.stores.delete(app.id);
  }
}
