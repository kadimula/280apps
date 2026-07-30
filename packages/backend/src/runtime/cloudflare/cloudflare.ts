// Runs deployed apps on Cloudflare Workers for Platforms: one User Worker per app in
// a dispatch namespace, with static assets, a D1 store, and the ISR cache as
// bindings. Go is normative (cloudflare.go).
//
// Activation is an ordered sequence, each step for a reason:
//   1. Create the app's D1 store if absent — a script binding a missing DB is rejected.
//   2. Open an asset upload session (path -> hash); Cloudflare asks only for hashes it lacks.
//   3. Upload those hashes, collect the completion token.
//   4. Seed the ISR cache before the flip, under the new build id so the live version cannot read it.
//   5. PUT the script with that token and bindings — the atomic flip.
//
// Every hash is salted with the app's salt: asset hashes are namespace-scoped, so
// without it two tenants with identical bytes would share an asset and observe each
// other's dedupe hits. A leak fix, not an optimization; cfHash is the only namer.

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { DeployCode, type DeployError } from '@280/contracts';
import type { Digest, BlobInfo } from '@280/contracts';
import type {
  Runtime as RuntimeSeam,
  Activation,
  RuntimeApp,
  RuntimeResult,
} from '../../seams.js';
import { StaticWorker } from './embed.js';

// API is the Cloudflare REST API root.
export const API = 'https://api.cloudflare.com/client/v4';

// DefaultCompatibilityDate is the date the adapter spike verified against.
export const DEFAULT_COMPATIBILITY_DATE = '2026-07-23';

const mainModule = 'worker.js';

// Bounds on one all-or-nothing bulk KV write, held well below Cloudflare's limits.
// 16 MiB, not 60: seedCache base64s then JSON.stringifies a batch (peak several times
// raw), inside the AppActivator Durable Object's 128 MiB isolate.
const KV_BULK_MAX_PAIRS = 1000;
const KV_BULK_MAX_BYTES = 16 << 20;

// FetchLike is the subset of global fetch this runtime uses, injected so tests can
// stand in for Cloudflare.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Config is the Cloudflare account config; nothing here is per-app.
export interface Config {
  accountId: string;
  apiToken: string;
  // The dispatch namespace User Workers live in.
  namespace: string;
  // Backs Next.js ISR. Wired on every app rather than opt-in, because ISR silently
  // no-ops without it.
  isrCacheKV: string;
  // Pins the Workers runtime semantics user code sees.
  compatibilityDate?: string;
  // Primary location hint for app stores.
  d1Location?: string;
  fetch?: FetchLike;
  // Bounds one request. Activation holds the CLI's connection open, so this bounds
  // how long a push can appear hung.
  timeoutMs?: number;
}

// A non-2xx (or success:false) response, carrying the status so Delete can turn a 404
// into idempotent success.
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// gone turns "already deleted" (404) into success, the whole of Delete's idempotency.
function gone(err: unknown): unknown | null {
  if (err instanceof ApiError && err.status === 404) {
    return null;
  }
  return err;
}

// cfHash is the app-scoped name of a blob inside the dispatch namespace. Cloudflare
// treats equal hashes as the same asset namespace-wide, so salting with the app's
// salt keeps two apps' identical bytes distinct. 16 bytes = 32 hex chars (cfHash
// vectors are frozen).
export function cfHash(salt: string, d: Digest): string {
  const sum = createHash('sha256').update(salt + ':' + d).digest();
  return sum.subarray(0, 16).toString('hex');
}

function storeName(app: RuntimeApp): string {
  return 'store-' + app.id.replace(/^app_/, '');
}

// notFoundHandling decides what an unknown path gets before server code. Next.js owns
// its own 404s; a static site has none to ask, so the asset router answers.
function notFoundHandling(framework: string): string {
  return framework === 'static' ? 'single-page-application' : 'none';
}

// An explicit table rather than a host mime lookup, so the content type a visitor
// receives does not depend on which image the control plane runs in.
const webTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

// contentType decides what a visitor's browser is told an asset is: Cloudflare stores
// and serves the upload's Content-Type verbatim, so this is the only place it is set.
// An unrecognized extension falls back to octet-stream (browsers download it).
export function contentType(urlPath: string): string {
  const ext = extname(urlPath).toLowerCase();
  return webTypes[ext] ?? 'application/octet-stream';
}

// One entry of a bulk write body; Cloudflare takes a bare array of these.
interface KVPair {
  key: string;
  value: string;
  base64: boolean;
}

interface Envelope {
  success?: boolean;
  result?: unknown;
  errors?: { code: number; message: string }[];
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function describe(status: number, errs: { code: number; message: string }[], raw: string): string {
  if (errs.length === 0) {
    return `cloudflare returned HTTP ${status}: ${truncate(raw, 300)}`;
  }
  return 'cloudflare: ' + errs.map((e) => `${e.code} ${e.message}`).join('; ');
}

// Runtime implements the runtime seam on Workers for Platforms.
export class Runtime implements RuntimeSeam {
  private readonly cfg: Required<Pick<Config, 'accountId' | 'apiToken' | 'namespace' | 'isrCacheKV'>> &
    Config;
  private readonly fetchImpl: FetchLike;
  private readonly compatibilityDate: string;
  private readonly timeoutMs: number;

  constructor(cfg: Config) {
    this.cfg = cfg as Runtime['cfg'];
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.compatibilityDate = cfg.compatibilityDate || DEFAULT_COMPATIBILITY_DATE;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  // Activate makes the deploy the app's serving version.
  async activate(act: Activation): Promise<RuntimeResult> {
    const out: RuntimeResult = { storeId: '' };

    let storeId = act.app.storeId;
    if (storeId === '') {
      const id = await this.createStore(act.app);
      storeId = id;
      out.storeId = id;
    }

    const assetsJWT = await this.uploadAssets(act);
    const worker = await this.workerModule(act);
    await this.seedCache(act);
    await this.putScript(act, worker, assetsJWT, storeId);
    return out;
  }

  // Delete removes the app from the runtime. The script goes first: an interruption
  // after it leaves an unreachable database rather than a live app with no data.
  async delete(app: RuntimeApp): Promise<void> {
    const script = `/accounts/${this.cfg.accountId}/workers/dispatch/namespaces/${this.cfg.namespace}/scripts/${app.script}`;
    try {
      await this.call('DELETE', script, undefined, '', false);
    } catch (e) {
      const err = gone(e);
      if (err) throw new Error('delete worker: ' + errMsg(err));
    }
    if (app.storeId === '') return;
    const store = `/accounts/${this.cfg.accountId}/d1/database/${app.storeId}`;
    try {
      await this.call('DELETE', store, undefined, '', false);
    } catch (e) {
      const err = gone(e);
      if (err) throw new Error('delete app store: ' + errMsg(err));
    }
  }

  private async createStore(app: RuntimeApp): Promise<string> {
    const body: Record<string, unknown> = { name: storeName(app) };
    if (this.cfg.d1Location) body['primary_location_hint'] = this.cfg.d1Location;

    let res: { uuid?: string };
    try {
      res = (await this.call(
        'POST',
        `/accounts/${this.cfg.accountId}/d1/database`,
        body,
        '',
        true,
      )) as { uuid?: string };
    } catch (err) {
      // A store left over from a half-finished first deploy must be adopted, not
      // duplicated: the retry has to converge on the same database.
      const id = await this.findStore(storeName(app)).catch(() => '');
      if (id) return id;
      throw new Error('create app store: ' + errMsg(err));
    }
    if (!res || !res.uuid) {
      throw new Error('create app store: cloudflare returned no database id');
    }
    return res.uuid;
  }

  private async findStore(name: string): Promise<string> {
    const res = (await this.call(
      'GET',
      `/accounts/${this.cfg.accountId}/d1/database?name=${name}`,
      undefined,
      '',
      true,
    )) as { uuid?: string; name?: string }[] | null;
    for (const db of res ?? []) {
      if (db.name === name) return db.uuid ?? '';
    }
    return '';
  }

  // uploadAssets runs the upload session and returns the completion token that
  // authorizes attaching these assets to the script.
  private async uploadAssets(act: Activation): Promise<string> {
    const manifest: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, BlobInfo>();
    for (const a of act.manifest.assets) {
      const h = cfHash(act.app.salt, a.digest);
      manifest[a.path] = { hash: h, size: a.size };
      byHash.set(h, a);
    }

    const path = `/accounts/${this.cfg.accountId}/workers/dispatch/namespaces/${this.cfg.namespace}/scripts/${act.app.script}/assets-upload-session`;
    const session = (await this.call('POST', path, { manifest }, '', true)) as {
      jwt?: string;
      buckets?: string[][];
    } | null;
    const jwt = session?.jwt ?? '';
    const buckets = session?.buckets ?? [];

    // No buckets means Cloudflare already holds every asset and the session token is
    // itself the completion token: the common server-only-change case.
    if (countFiles(buckets) === 0) {
      return jwt;
    }

    let completion = '';
    for (const bucket of buckets) {
      const token = await this.uploadBucket(act, jwt, bucket, byHash);
      if (token) completion = token; // only the final bucket's response carries it
    }
    if (completion === '') {
      throw new Error('upload assets: cloudflare returned no completion token');
    }
    return completion;
  }

  // uploadBucket sends one bucket of assets: base64 bodies in a multipart form whose
  // field names are the asset hashes, authenticated with the session JWT.
  private async uploadBucket(
    act: Activation,
    jwt: string,
    bucket: string[],
    byHash: Map<string, BlobInfo>,
  ): Promise<string> {
    const form = new FormData();
    for (const h of bucket) {
      const info = byHash.get(h);
      if (!info) {
        throw new Error(
          `upload assets: cloudflare asked for hash ${h}, which this deploy never declared`,
        );
      }
      const content = await act.asset(info.digest);
      const b64 = Buffer.from(content).toString('base64');
      form.append(h, new Blob([b64], { type: contentType(info.path) }), h);
    }

    const url = `${API}/accounts/${this.cfg.accountId}/workers/assets/upload?base64=true`;
    let res: { jwt?: string };
    try {
      res = (await this.form('POST', url, form, jwt, true)) as { jwt?: string };
    } catch (e) {
      throw new Error('upload assets: ' + errMsg(e));
    }
    return res?.jwt ?? '';
  }

  // seedCache writes the deploy's prerendered ISR entries into the cache namespace.
  // Keys are verbatim: the worker derives the same key from its build id at read time,
  // so any normalization here never hits. KV upserts are this step's idempotency.
  private async seedCache(act: Activation): Promise<void> {
    if (this.cfg.isrCacheKV === '' || act.manifest.cache.length === 0) return;
    const path = `/accounts/${this.cfg.accountId}/storage/kv/namespaces/${this.cfg.isrCacheKV}/bulk`;

    let batch: KVPair[] = [];
    let raw = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      try {
        await this.call('PUT', path, batch, '', false);
      } catch (e) {
        throw new Error('seed isr cache: ' + errMsg(e));
      }
      batch = [];
      raw = 0;
    };

    for (const e of act.manifest.cache) {
      const content = await act.asset(e.digest);
      if (batch.length >= KV_BULK_MAX_PAIRS || raw + content.length > KV_BULK_MAX_BYTES) {
        await flush();
      }
      batch.push({
        key: e.path,
        value: Buffer.from(content).toString('base64'),
        base64: true,
      });
      raw += content.length;
    }
    await flush();
  }

  // workerModule returns the JavaScript to run for this deploy. Static-only apps have
  // no server code, so the platform supplies the serving worker rather than the CLI.
  private async workerModule(act: Activation): Promise<Uint8Array> {
    if (act.app.framework === 'static') {
      return StaticWorker;
    }
    try {
      return await act.asset(act.manifest.worker.digest);
    } catch (e) {
      throw new Error('read worker: ' + errMsg(e));
    }
  }

  // putScript uploads the User Worker. Its success is the moment the app starts
  // serving this deploy.
  private async putScript(
    act: Activation,
    worker: Uint8Array,
    assetsJWT: string,
    storeId: string,
  ): Promise<void> {
    const metadata: Record<string, unknown> = {
      main_module: mainModule,
      compatibility_date: this.compatibilityDate,
      compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
      bindings: this.bindings(storeId),
      tags: ['app:' + act.app.id, 'deploy:' + act.deployId],
    };
    if (assetsJWT !== '') {
      metadata['assets'] = {
        jwt: assetsJWT,
        config: {
          html_handling: 'auto-trailing-slash',
          not_found_handling: notFoundHandling(act.app.framework),
        },
      };
    }

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append(
      mainModule,
      new Blob([worker], { type: 'application/javascript+module' }),
      mainModule,
    );

    const url = `${API}/accounts/${this.cfg.accountId}/workers/dispatch/namespaces/${this.cfg.namespace}/scripts/${act.app.script}`;
    try {
      await this.form('PUT', url, form, this.cfg.apiToken, false);
    } catch (e) {
      throw new Error('upload worker: ' + errMsg(e));
    }
  }

  // bindings are what server code sees on env; every app gets the same set. Notably
  // absent: WORKER_SELF_REFERENCE — service bindings cannot resolve a script inside a
  // dispatch namespace (Cloudflare API 10143), and ISR still works without it.
  bindings(storeId: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [
      { type: 'assets', name: 'ASSETS' },
      { type: 'd1', name: 'store', id: storeId },
      // The OpenNext worker routes /_next/image through env.IMAGES. Missing, the
      // app still deploys and serves; only next/image requests fail.
      { type: 'images', name: 'IMAGES' },
    ];
    if (this.cfg.isrCacheKV !== '') {
      // OpenNext's KV incremental-cache override requires this exact name.
      out.push({
        type: 'kv_namespace',
        name: 'NEXT_INC_CACHE_KV',
        namespace_id: this.cfg.isrCacheKV,
      });
    }
    return out;
  }

  // call issues a JSON request against the Cloudflare API. jwt, when set, replaces the
  // account token (asset uploads authenticate with the session JWT).
  private async call(
    method: string,
    path: string,
    body: unknown,
    jwt: string,
    wantResult: boolean,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + (jwt !== '' ? jwt : this.cfg.apiToken),
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return this.send(API + path, init, wantResult);
  }

  // form issues a multipart request. The boundary'd Content-Type is set by
  // FormData, so it must not be provided here.
  private async form(
    method: string,
    url: string,
    body: FormData,
    token: string,
    wantResult: boolean,
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      body,
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    return this.send(url, init, wantResult);
  }

  // send executes a request and unwraps Cloudflare's envelope. Cloudflare reports
  // failures both by status and by `success: false` on a 200, so both are checked.
  private async send(url: string, init: RequestInit, wantResult: boolean): Promise<unknown> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, init);
    } catch (e) {
      const err: DeployError = {
        code: DeployCode.Unavailable,
        message: 'cloudflare api unreachable: ' + errMsg(e),
        fix: '',
        retryable: true,
        candidates: [],
      };
      throw err;
    }

    const text = await resp.text();
    const raw = text.length > 1 << 20 ? text.slice(0, 1 << 20) : text;

    let env: Envelope | undefined;
    let decoded = false;
    try {
      env = JSON.parse(raw) as Envelope;
      decoded = true;
    } catch {
      decoded = false;
    }
    const errs = decoded && env && Array.isArray(env.errors) ? env.errors : [];

    if (
      Math.floor(resp.status / 100) !== 2 ||
      // Mirror Go's `!env.Success`: an absent success field is the zero value
      // false, so a decoded body reporting errors without success:true is an error.
      (decoded && env !== undefined && env.success !== true && errs.length > 0)
    ) {
      throw new ApiError(resp.status, describe(resp.status, errs, raw));
    }
    if (!wantResult) return undefined;

    if (!decoded) {
      // Mirror Go: with no envelope, the whole body is decoded into the result.
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new Error('decode cloudflare response: ' + errMsg(e));
      }
    }
    let payload: unknown = env?.result;
    if (payload === undefined) payload = env; // absent result key -> whole body
    return payload;
  }
}

function countFiles(buckets: string[][]): number {
  let n = 0;
  for (const b of buckets) n += b.length;
  return n;
}
