// The per-app activation Durable Object: keyed via idFromName(appId), it is the
// single global instance for that app and runs everything through one promise
// chain (ActivatorCore), serializing an app's activation and delete platform-wide.
// This is the only module that imports `cloudflare:workers` (the base does not
// resolve under node), so the executor lives in activator.ts for the node tests;
// the DO is a thin shell that builds per-execution deps from env and forwards to it.

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

// One execution's I/O, the activation counterpart to deps.ts's buildRequestDeps:
// a fresh lazily-connected pg client per execution (mirroring the request path).
// selectRuntime throws on a misconfigured account, surfacing as an activation failure.
export function buildActivatorDeps(env: Env, log: Logger): ActivatorDeps {
  const config = readConfig(env);
  return {
    store: newPgStore(config.dbConnectionString, config.dbSchema),
    blobs: new R2BlobStore(env.BLOBS),
    runtime: selectRuntime(config, log),
  };
}

// Lets a Miniflare test swap in in-memory deps, shrink retry/watchdog timings, and
// drive a logical clock. A far-future clock keeps armed alarms from auto-firing so
// the test steps them deterministically via runDurableObjectAlarm. Untouched in production.
export interface ActivatorTestConfig {
  depsFactory?: (env: Env) => ActivatorDeps;
  options?: ActivatorOptions;
  now?: () => number;
}

let testConfig: ActivatorTestConfig | null = null;

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

  // Built once per object incarnation so the promise chain and in-memory busy
  // guard persist across calls; on eviction the durable task and alarm rebuild it.
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

  // Persists the task and arms the alarm, then returns; the claim and runtime round
  // trip happen under the alarm, off the request that landed the last blob.
  async activate(params: ActivateParams): Promise<void> {
    await this.getCore().enqueue(params);
  }

  async delete(params: DeleteParams): Promise<DeleteOutcome> {
    return this.getCore().runDelete(params);
  }

  override async alarm(): Promise<void> {
    await this.getCore().onAlarm();
  }
}
