// push runs the deploy loop against a deploy.Port: the CLI's one stateful algorithm,
// kept separate from command wiring so it is testable against a Port double.
// Strategy: Sync (begin/resume), upload whatever Sync says is missing, poll Status
// to terminal. Every step is idempotent, so any transient error just re-runs from
// Sync. Hard ordering rule: persist the resolved appId before uploading any blob,
// so a crash mid-push never creates a second app on the retry.
// Spec: cli/internal/push/push.go; Go is normative.

import { Readable } from 'node:stream';
import {
  type Port,
  type SyncRequest,
  type SyncResult,
  type DeployStatus,
  type App,
  type Digest,
  type Manifest,
  State,
  Resolution,
  stateTerminal,
} from '@280/contracts';
import * as config from './config.js';

// Bundle is what the bundler produces and push consumes: the manifest to sync and
// the blob bytes to upload, keyed by digest.
export interface Bundle {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
  notes: string[];
}

// Options tunes one push.
export interface Options {
  root: string; // project root
  gitRemote?: string; // origin URL for fingerprint dedup; "" when none
  forceNew?: boolean; // --new: always create a fresh app
  // maxAttempts bounds retries of a single retryable step (default 6). backoff
  // is the base delay in ms between them (0 in tests).
  maxAttempts?: number;
  backoffMs?: number;
}

// Result is what a completed push produced. notice is a server-side one-liner
// the CLI relays verbatim (e.g. a dashboard access override diverging from
// 280.json); '' when there is nothing to say.
export interface Result {
  app: App;
  resolution: string;
  deployId: string;
  url: string;
  notice: string;
}

// Events lets the caller narrate progress without push knowing about output.
// Any omitted hook is skipped.
export interface Events {
  onResolve?: (app: App, r: string) => void; // app resolved (persist happens right after)
  onUpload?: (done: number, total: number) => void; // a blob landed
  onWait?: () => void; // upload complete, awaiting activation
}

const DEFAULT_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 5000;

function attempts(o: Options): number {
  return o.maxAttempts && o.maxAttempts > 0 ? o.maxAttempts : DEFAULT_ATTEMPTS;
}

// isRetryable mirrors Go: only the seam's Retryable errors are re-tried; every
// other error (including any non-typed throw) is terminal.
function isRetryable(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === true);
}

// run deploys the built project. cfg is updated in place (and persisted) when
// the server assigns the appId. port carries all platform behavior.
export async function run(
  port: Port,
  cfg: config.Config,
  b: Bundle,
  opts: Options,
  ev: Events = {},
): Promise<Result> {
  const req: SyncRequest = {
    identity: {
      appId: cfg.appId,
      slug: cfg.name,
      framework: cfg.framework,
      gitRemote: opts.gitRemote ?? '',
      clientRef: cfg.clientRef,
      forceNew: opts.forceNew ?? false,
    },
    manifest: b.manifest,
  };

  // The run's resolution is the first Sync's (created/linked/reused). Later
  // re-Syncs report "existing", so they must not overwrite it.
  let resolution: string = Resolution.Existing;
  let resolved = false;

  for (;;) {
    const res = await retry(opts, () => port.sync(req));
    if (!resolved) {
      resolution = res.resolution;
      resolved = true;
    }

    // Persist the app identity the instant the server assigns it, before any
    // upload: the duplicate-app guard.
    if (res.app.id !== '' && cfg.appId !== res.app.id) {
      cfg.appId = res.app.id;
      req.identity.appId = res.app.id;
      config.save(opts.root, cfg);
      ev.onResolve?.(res.app, res.resolution);
    }

    if (res.state === State.Failed && res.failure) {
      throw res.failure;
    }

    if (res.missing.length > 0) {
      await uploadMissing(port, res.app.id, b, res.missing, opts, ev);
      continue; // re-Sync: missing shrinks, server activates when complete
    }

    if (stateTerminal(res.state)) {
      return finish(port, res, resolution, opts);
    }

    ev.onWait?.();
    const status = await poll(port, res.app, res.deployId, opts);
    if (status.failure) throw status.failure;
    return { app: res.app, resolution, deployId: res.deployId, url: status.url, notice: status.notice };
  }
}

async function uploadMissing(
  port: Port,
  appId: string,
  b: Bundle,
  missing: Digest[],
  opts: Options,
  ev: Events,
): Promise<void> {
  const total = missing.length;
  for (let i = 0; i < missing.length; i++) {
    const dig = missing[i]!;
    const data = b.content.get(dig) ?? new Uint8Array();
    // Sequential, one blob at a time, each idempotent and retried only on
    // retryable errors.
    await retry(opts, () => port.putBlob(appId, dig, data.length, Readable.from([Buffer.from(data)])));
    ev.onUpload?.(i + 1, total);
  }
}

async function finish(port: Port, res: SyncResult, resolution: string, opts: Options): Promise<Result> {
  const status = await poll(port, res.app, res.deployId, opts);
  if (status.failure) throw status.failure;
  const url = status.url !== '' ? status.url : res.app.url;
  return { app: res.app, resolution, deployId: res.deployId, url, notice: status.notice };
}

// poll waits for a deploy to reach a terminal state.
async function poll(port: Port, app: App, deployId: string, opts: Options): Promise<DeployStatus> {
  for (let attempt = 0; ; attempt++) {
    const status = await retry(opts, () => port.status(app.id, deployId));
    if (stateTerminal(status.state)) return status;
    await sleep(backoffFor(opts, attempt));
  }
}

// retry runs fn, repeating only on the seam's Retryable errors, with backoff.
async function retry<T>(opts: Options, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  const n = attempts(opts);
  for (let attempt = 0; attempt < n; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      last = err;
      await sleep(backoffFor(opts, attempt));
    }
  }
  throw last;
}

// backoffFor doubles the base delay per attempt, capped at 5s. A zero base means
// no delay, which the test suite runs on.
function backoffFor(opts: Options, attempt: number): number {
  const base = opts.backoffMs ?? 0;
  if (base === 0) return 0;
  let d = base;
  for (let i = 0; i < attempt && d < MAX_BACKOFF_MS; i++) d *= 2;
  return d;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
