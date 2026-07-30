// AppActivator is the per-app activation Durable Object: keyed per app via
// idFromName(appId), it is the single global instance for that app across every
// isolate, and everything it does runs through one promise chain (ActivatorCore).
// That serialized chain is the cross-isolate replacement for the retired
// in-isolate withAppLock — a given app activates or deletes one operation at a
// time, platform-wide.
//
// This is the only module that imports `cloudflare:workers` (the DurableObject
// base does not resolve under node), so the executor it delegates to lives in
// activator.ts, which the node test suites import freely. The DO here is a thin
// durable shell: it holds the object's storage and env, builds a fresh set of
// per-execution deps from that env (a fresh pg client, R2-backed blobs, the
// configured runtime), and forwards RPC calls and alarms to the core.

import { DurableObject } from 'cloudflare:workers';
import {
  ActivatorCore,
  type ActivateParams,
  type ActivatorDeps,
  type ActivatorOptions,
  type DeleteOutcome,
  type DeleteParams,
} from './activator.js';
import { selectRuntime } from './deps.js';
import { newPgStore } from './store/store.js';
import { R2BlobStore } from './blobstore/r2.js';
import { readConfig, type Env } from './config.js';
import { newLogger } from './logger.js';
import type { Logger } from './observe.js';

// buildActivatorDeps builds one execution's I/O from Env, the counterpart to
// deps.ts's buildRequestDeps but for activation: a fresh (lazily-connected) pg
// client, the R2 blob store, and the configured runtime. A fresh client per
// execution mirrors the request path — a client is opened on the first statement
// and ended when the execution closes it. selectRuntime throws on a
// misconfigured account, which surfaces as the deploy's activation failure.
export function buildActivatorDeps(env: Env, log: Logger): ActivatorDeps {
  const config = readConfig(env);
  return {
    store: newPgStore(config.dbConnectionString, config.dbSchema),
    blobs: new R2BlobStore(env.BLOBS),
    runtime: selectRuntime(config, log),
  };
}

// ActivatorTestConfig lets a Miniflare test swap in an in-memory store/runtime,
// shrink the retry/watchdog timings, and drive a logical clock — without a
// database or the real Cloudflare API. A far-future clock keeps armed alarms from
// auto-firing, so the test steps them deterministically with runDurableObjectAlarm
// while advancing the same clock the watchdog reads. The Durable Object and the
// test run in one Miniflare worker isolate, so this module-level seam is shared
// between them. Untouched in production.
export interface ActivatorTestConfig {
  depsFactory?: (env: Env) => ActivatorDeps;
  options?: ActivatorOptions;
  now?: () => number;
}

let testConfig: ActivatorTestConfig | null = null;

// __setActivatorTestConfig installs (or clears, with null) the test overrides.
// Test-only; production never calls it, so the object always builds real deps.
export function __setActivatorTestConfig(config: ActivatorTestConfig | null): void {
  testConfig = config;
}

export class AppActivator extends DurableObject<Env> {
  private core: ActivatorCore | null = null;
  private readonly log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = newLogger(env.TWO80_LOG_FORMAT === 'json' ? 'json' : 'text');
  }

  // getCore builds the executor once per object incarnation, so the promise chain
  // and the in-memory busy guard persist across this instance's calls and alarms.
  // On eviction a fresh instance rebuilds it; the durable task record and alarm
  // are what carry an in-flight activation across that boundary.
  private getCore(): ActivatorCore {
    if (this.core !== null) return this.core;
    const factory = testConfig?.depsFactory ?? ((env: Env) => buildActivatorDeps(env, this.log));
    this.core = new ActivatorCore({
      storage: this.ctx.storage,
      depsFactory: () => factory(this.env),
      now: testConfig?.now ?? (() => Date.now()),
      log: this.log,
      options: testConfig?.options,
    });
    return this.core;
  }

  // activate persists the task and arms the alarm, then returns — the claim and
  // the runtime round trip happen under the alarm, so the request that landed the
  // last blob is not held open for them.
  async activate(params: ActivateParams): Promise<void> {
    await this.getCore().enqueue(params);
  }

  // delete runs the destructive tail serialized against any in-flight activation
  // and returns its outcome (a delete-domain failure comes back as data so its
  // fields survive the RPC boundary).
  async delete(params: DeleteParams): Promise<DeleteOutcome> {
    return this.getCore().runDelete(params);
  }

  // alarm is the executor: it runs one activation attempt (or the watchdog) for
  // the current task through the same chain delete uses.
  override async alarm(): Promise<void> {
    await this.getCore().onAlarm();
  }
}
