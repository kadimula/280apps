// Runs deployed apps on Cloudflare Workers for Platforms: one User Worker per
// app inside a dispatch namespace, with static assets, a D1 store, and the ISR
// cache attached as bindings.
// Spec: platform/internal/runtime/cloudflare/cloudflare.go. Go is normative.
//
// Activation is an ordered sequence, in this order and for these reasons:
//
//   1. Create the app's D1 store, if it has none. First, because a script that
//      binds a database that does not exist is rejected outright.
//   2. Open an asset upload session with a manifest of path -> hash. Cloudflare
//      answers with only the hashes it lacks, so a server-only change uploads
//      nothing.
//   3. Upload those hashes and collect the completion token.
//   4. Write the deploy's ISR cache seed into the KV namespace, before the flip:
//      a script already live must never observe a half-seeded cache for its own
//      build id. Seed keys carry the new build id, so the currently serving
//      version cannot read them and the write is invisible until step 5.
//   5. PUT the script into the dispatch namespace with that token and the
//      bindings. This is the atomic flip.
//
// Every hash crossing into Cloudflare is salted with the app's own salt: asset
// hashes are namespace-scoped, so without the salt two tenants holding identical
// bytes would share an asset and observe each other's dedupe hits. That is a
// leak fix, not an optimization, and cfHash is the only way this package names an
// asset.

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

// Bounds on one bulk KV write. Cloudflare's own limits are 10,000 pairs and a
// 100MB request; both are held well below because the request is all-or-nothing
// and a rejected batch fails the whole deploy. The byte budget is counted on raw
// content, leaving room for base64's 4/3 inflation and the JSON envelope.
const KV_BULK_MAX_PAIRS = 1000;
const KV_BULK_MAX_BYTES = 60 << 20;

// FetchLike is the subset of the global fetch this runtime uses. Injected so
// tests can stand in for Cloudflare; production defaults to the platform fetch.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Config is everything the runtime needs about the Cloudflare account. Nothing
// here is per-app.
export interface Config {
  accountId: string;
  apiToken: string;
  // namespace is the dispatch namespace User Workers live in.
  namespace: string;
  // isrCacheKV backs Next.js incremental static regeneration. Wired on every
  // app rather than opt-in, because ISR silently no-ops without it.
  isrCacheKV: string;
  // compatibilityDate pins the Workers runtime semantics user code sees.
  compatibilityDate?: string;
  // d1Location is the primary location hint for app stores.
  d1Location?: string;
  fetch?: FetchLike;
  // timeoutMs bounds one request. Activation holds the CLI's connection open, so
  // this bounds how long a push can appear hung.
  timeoutMs?: number;
}

// apiError is a non-2xx (or success:false) response from Cloudflare, carrying the
// status so Delete can turn a 404 into idempotent success.
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// gone turns "already deleted" (404) into success, which is the whole of
// Delete's idempotency. Any other error passes through.
function gone(err: unknown): unknown | null {
  if (err instanceof ApiError && err.status === 404) {
    return null;
  }
  return err;
}

// cfHash is the app-scoped name of a blob inside the dispatch namespace.
// Cloudflare wants a 32-hex-character content hash and treats equal hashes as
// the same asset across the whole namespace; salting with the app's salt keeps
// two apps' identical bytes distinct. Spec: cloudflare.go cfHash; the width is
// 16 bytes = 32 hex chars, asserted by the frozen cfHash vectors.
export function cfHash(salt: string, d: Digest): string {
  const sum = createHash('sha256').update(salt + ':' + d).digest();
  return sum.subarray(0, 16).toString('hex');
}

function storeName(app: RuntimeApp): string {
  return 'store-' + app.id.replace(/^app_/, '');
}

// notFoundHandling decides what a request for an unknown path gets before it
// reaches server code. Next.js owns its own 404s; a static site has no server
// code to ask, so the asset router answers.
function notFoundHandling(framework: string): string {
  return framework === 'static' ? 'single-page-application' : 'none';
}

// webTypes is what a deployed site is actually made of. An explicit table rather
// than a host mime lookup alone, so the content type a visitor receives does not
// depend on which image the control plane happens to run in.
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

// contentType is what a visitor's browser will be told this asset is. Cloudflare
// stores the upload's Content-Type verbatim and serves it back, so this is the
// only place the answer is decided. An unrecognized extension falls back to
// octet-stream, which browsers download rather than render.
export function contentType(urlPath: string): string {
  const ext = extname(urlPath).toLowerCase();
  return webTypes[ext] ?? 'application/octet-stream';
}

// kvPair is one entry of a bulk write body. Cloudflare takes a bare array of
// these, not an object wrapping one.
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

  // Delete removes the app from the runtime. The script goes first: it is what
  // visitors reach, so an interruption after this point leaves an unreachable
  // database rather than a live app whose data has been pulled out from under it.
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

  // ---- step 1: the app's store ----

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

  // ---- steps 2 and 3: static assets ----

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

    // No buckets means Cloudflare already holds every asset, and the session
    // token is itself the completion token. The common case for a server-only
    // change, and the reason a redeploy uploads almost nothing.
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

  // uploadBucket sends one bucket of assets. Cloudflare requires base64 bodies in
  // a multipart form whose field names are the asset hashes, authenticated with
  // the session JWT rather than the account token.
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

  // ---- step 4: the ISR cache seed ----

  // seedCache writes the deploy's prerendered ISR entries into the cache
  // namespace. Keys are written verbatim: the worker derives the same key from
  // its own build id at read time, so any prefix or normalization here is a cache
  // that never hits. KV writes are upserts, which is this step's idempotency.
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

  // ---- step 5: the script ----

  // workerModule returns the JavaScript to run for this deploy. Static-only apps
  // have no server code of their own, so the platform supplies the serving worker
  // rather than shipping a stub through the CLI.
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

  // putScript uploads the User Worker. Returning success is the moment the app
  // starts serving this deploy.
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

  // bindings are what server code sees on env. Every app gets the same set.
  //
  // Notably absent: WORKER_SELF_REFERENCE. Service bindings cannot resolve a
  // script inside a dispatch namespace (Cloudflare API 10143), so the OpenNext
  // template's default fails every deploy. ISR still works without it.
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

  // ---- transport ----

  // call issues a JSON request against the Cloudflare API. jwt, when set,
  // replaces the account token (asset uploads authenticate with the session JWT).
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
  // failures both by status and by `success: false` with a 200, so both checked.
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
