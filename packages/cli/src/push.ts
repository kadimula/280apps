import { Readable } from 'node:stream';
import {
  type Port,
  type SyncRequest,
  type SyncResult,
  type DeployStatus,
  type App,
  type Digest,
  type Manifest,
  type DeployError,
  DeployCode,
  State,
  Resolution,
  stateTerminal,
} from '@280/contracts';
import * as config from './config.js';
export interface Bundle {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
  notes: string[];
}
export interface Options {
  root: string; // project root
  gitRemote?: string; // origin URL for fingerprint dedup; "" when none
  forceNew?: boolean; // --new: always create a fresh app
  maxAttempts?: number;
  backoffMs?: number;
}
export interface Result {
  app: App;
  resolution: string;
  deployId: string;
  url: string;
  notice: string;
}
export interface Events {
  onResolve?: (app: App, r: string) => void; // app resolved (persist happens right after)
  onUpload?: (done: number, total: number) => void; // a blob landed
  onWait?: () => void; // upload complete, awaiting activation
  onSecretNotice?: (notice: string) => void;
}
const DEFAULT_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 5000;
function attempts(o: Options): number {
  return o.maxAttempts && o.maxAttempts > 0 ? o.maxAttempts : DEFAULT_ATTEMPTS;
}
function isRetryable(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === true);
}
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
  let resolution: string = Resolution.Existing;
  let resolved = false;
  for (;;) {
    const res = await retry(opts, () => port.sync(req));
    if (!resolved) {
      resolution = res.resolution;
      resolved = true;
    }
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
      return finish(port, res, resolution, opts, ev);
    }
    ev.onWait?.();
    const status = await poll(port, res.app, res.deployId, opts, ev);
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
    await retry(opts, () => port.putBlob(appId, dig, data.length, Readable.from([Buffer.from(data)])));
    ev.onUpload?.(i + 1, total);
  }
}
async function finish(
  port: Port,
  res: SyncResult,
  resolution: string,
  opts: Options,
  ev: Events,
): Promise<Result> {
  const status = await poll(port, res.app, res.deployId, opts, ev);
  if (status.failure) throw status.failure;
  const url = status.url !== '' ? status.url : res.app.url;
  return { app: res.app, resolution, deployId: res.deployId, url, notice: status.notice };
}
async function poll(
  port: Port,
  app: App,
  deployId: string,
  opts: Options,
  ev: Events,
): Promise<DeployStatus> {
  for (let attempt = 0; ; attempt++) {
    const status = await retry(opts, () => port.status(app.id, deployId));
    if (status.state === State.WaitingSecrets) throw credentialsRequired(status.secretNotice);
    if (stateTerminal(status.state)) {
      if (status.secretNotice !== '') ev.onSecretNotice?.(status.secretNotice);
      return status;
    }
    await sleep(backoffFor(opts, attempt));
  }
}
function credentialsRequired(notice: string): DeployError {
  const dashboardUrl = notice.match(/https?:\/\/\S+/)?.[0].replace(/[.,;:!?]+$/, '');
  return {
    code: DeployCode.CredentialsRequired,
    message: notice || 'deployment is waiting for credentials before it can go live',
    fix: dashboardUrl
      ? `ask your user to configure the missing credentials at ${dashboardUrl}, then run \`two80 push\` again`
      : 'ask your user to configure the missing credentials in the 280 dashboard, then run `two80 push` again',
    retryable: false,
    candidates: [],
  };
}
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
