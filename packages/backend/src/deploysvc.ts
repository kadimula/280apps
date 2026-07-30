// deploysvc is the server side of the deploy seam: the implementation of the
// contracts deploy Port that the HTTP API is a thin transport over.
//
// Spec: platform/internal/deploysvc/deploysvc.go. Go is normative, including
// every invariant documented in the seam's doc comment: methods are idempotent
// and safe to re-invoke after any interruption, which is why nothing here holds
// state between calls. Everything a resumed push needs is in the store and the
// blob store.

import {
  DeployCode,
  DeployErr,
  MANIFEST_KIND_BUNDLE,
  MAX_WORKER_GZIP_BYTES,
  Resolution,
  State,
  canonicalDigest,
  digestBytes,
  manifestBlobs,
  stateTerminal,
  type App as PublicApp,
  type Digest,
  type DeployError,
  type DeployStatus,
  type DeleteRequest,
  type DeleteResult,
  type Identity,
  type Manifest,
  type Port,
  type SyncRequest,
  type SyncResult,
  type BlobBody,
} from '@280/contracts';
import { randomBytes } from 'node:crypto';
import type { App, BlobStore, Deploy, Store } from './seams.js';
import type { Activator } from './activator.js';

// The throwable is the contract's canonical DeployErr, so the HTTP adapter, the
// conformance suite, and every caller share one error type. deployShaped
// duck-types a caught value into the seam's plain error fields: the blob store
// (W4) throws its own DeployErr subclass with the same shape but a different
// identity, so `instanceof` alone would miss it.
export function deployShaped(err: unknown): DeployError | null {
  if (err instanceof DeployErr) {
    return { code: err.code, message: err.message, fix: err.fix, retryable: err.retryable, candidates: err.candidates };
  }
  if (err instanceof Error && typeof (err as { code?: unknown }).code === 'string') {
    const e = err as unknown as { code: string; fix?: unknown; retryable?: unknown; candidates?: unknown };
    return {
      code: e.code,
      message: err.message,
      fix: typeof e.fix === 'string' ? e.fix : '',
      retryable: e.retryable === true,
      candidates: Array.isArray(e.candidates) ? (e.candidates as string[]) : [],
    };
  }
  return null;
}

// asDeployErr returns a canonical DeployErr for a deploy-shaped caught value, so
// a seam error thrown by a different workstream's class rethrows as our type.
export function asDeployErr(err: unknown): DeployErr | null {
  const s = deployShaped(err);
  return s === null ? null : new DeployErr(s);
}

// Platform is the account-independent half: storage, config, and the activator.
export interface PlatformDeps {
  store: Store;
  blobs: BlobStore;
  // activator serializes one app's activation and delete and executes them. In
  // production it hands the work to the app's AppActivator Durable Object, which
  // provides cross-isolate per-app serialization (the real replacement for the
  // retired in-isolate withAppLock); in tests it runs activation inline. The
  // runtime lives behind it, so the Platform no longer holds one directly.
  activator: Activator;
  // appDomain is the zone app URLs live on, e.g. "280apps.run".
  appDomain: string;
  // hostSuffix is appended to an app's URL host label (not its script name), so a
  // staging deployment can emit first-level suffix hostnames like
  // "<slug>-<token>-staging.280apps.run" that free Universal SSL still covers
  // (a second-level "staging.280apps.run" would not). The script name stays bare,
  // so the dispatcher recovers it by stripping the suffix (HOST_SUFFIX). Empty is
  // the default and reproduces Go byte for byte; the divergence is a new env.
  hostSuffix?: string;
}

export class Platform {
  readonly store: Store;
  readonly blobs: BlobStore;
  readonly activator: Activator;
  readonly appDomain: string;
  readonly hostSuffix: string;

  constructor(deps: PlatformDeps) {
    this.store = deps.store;
    this.blobs = deps.blobs;
    this.activator = deps.activator;
    this.appDomain = deps.appDomain;
    this.hostSuffix = deps.hostSuffix ?? '';
  }

  // for returns the Port scoped to an account. Created per request so the
  // account is a field rather than a parameter on every method: a query that
  // forgets to scope by account is then not expressible.
  for(accountId: string): Service {
    return new Service(this, accountId);
  }
}

// Service implements the deploy Port for one authenticated account.
export class Service implements Port {
  constructor(
    private readonly p: Platform,
    private readonly accountId: string,
  ) {}

  // ---- Sync ----

  async sync(req: SyncRequest): Promise<SyncResult> {
    // Preflight first: rejecting the manifest must change no state, so it has
    // to happen before the app is created, not after.
    preflight(req.manifest);

    const { app, resolution } = await this.resolve(req.identity);

    // The request is its own idempotency key: same app + same manifest content
    // means the same deploy, so a retried push resumes instead of forking.
    const deployId = deriveDeployId(app.id, req.manifest);
    let dep = await this.wrapInternal('open deploy', () =>
      this.p.store.openDeploy({
        appId: app.id,
        id: deployId,
        manifest: req.manifest,
        state: State.Uploading,
        failure: null,
      }),
    );

    const missing = await this.wrapInternal('list missing blobs', () =>
      this.p.blobs.missing(app.id, manifestBlobs(dep.manifest)),
    );

    // A re-Sync of an already-complete deploy is the resume path after a crash
    // between the last upload and activation. Nothing else would ever finish it.
    if (missing.length === 0 && !stateTerminal(dep.state)) {
      dep = await this.settle(app, dep);
    }

    return {
      app: publicApp(app),
      resolution,
      deployId,
      state: dep.state,
      missing,
      failure: dep.failure ?? undefined,
    };
  }

  // ---- identity resolution ----

  // resolve maps an Identity onto an app, creating one if nothing matches. The
  // order is the contract's: explicit id, then fingerprint autolink, then
  // clientRef, then create.
  private async resolve(id: Identity): Promise<{ app: App; resolution: string }> {
    if (id.appId !== '') {
      const app = await this.wrapInternal('look up app', () =>
        this.p.store.app(this.accountId, id.appId),
      );
      if (app === null) {
        throw new DeployErr({
          code: DeployCode.NoSuchApp,
          message: `app "${id.appId}" does not exist on this account`,
          fix: 'run 280 list, then 280 link <app-id>, or 280 push --new',
        });
      }
      return { app, resolution: Resolution.Existing };
    }

    if (!id.forceNew) {
      if (id.gitRemote !== '') {
        const matches = await this.wrapInternal('match fingerprint', () =>
          this.p.store.appsByFingerprint(this.accountId, fingerprint(id.gitRemote, id.slug)),
        );
        if (matches.length === 1) {
          return { app: matches[0]!, resolution: Resolution.FingerprintLinked };
        }
        if (matches.length > 1) {
          throw new DeployErr({
            code: DeployCode.AmbiguousIdentity,
            message: `${matches.length} apps match this project`,
            fix: 'run 280 link <app-id> to pick one, or 280 push --new',
            candidates: matches.map((a) => a.id),
          });
        }
      }
      if (id.clientRef !== '') {
        const app = await this.wrapInternal('match client ref', () =>
          this.p.store.appByClientRef(this.accountId, id.clientRef),
        );
        if (app !== null) {
          return { app, resolution: Resolution.Existing };
        }
      }
    }

    const app = await this.createApp(id);
    return { app, resolution: Resolution.Created };
  }

  // createApp allocates an app's permanent identity: its id, its script name,
  // its URL, and its asset salt. None of these ever change, which is what makes
  // an app's URL survive every redeploy.
  private async createApp(id: Identity): Promise<App> {
    const slug = sanitizeSlug(id.slug);
    const appId = 'app_' + randomHex(6);
    // The script name is environment-independent: it is the app's bare identity
    // in the dispatch namespace and the runtime upload/AppByScript key. The host
    // suffix rides only on the URL host label, so staging serves the same script
    // at "<script>-staging.280apps.run" while the staging dispatcher strips the
    // suffix back to this bare name for lookup (platform/dispatcher, HOST_SUFFIX;
    // tests/staging-cloudflare.md). Empty suffix ⇒ URL identical to Go.
    const script = slug + '-' + urlToken(appId);

    const app: App = {
      id: appId,
      accountId: this.accountId,
      slug,
      framework: id.framework,
      script,
      url: 'https://' + script + this.p.hostSuffix + '.' + this.p.appDomain,
      salt: randomHex(16),
      fingerprint: id.gitRemote !== '' ? fingerprint(id.gitRemote, slug) : '',
      // --new must always create, so it must not claim the nonce that would make
      // the next push dedupe onto this app.
      clientRef: id.forceNew ? '' : id.clientRef,
      storeId: '',
      activeDeploy: '',
    };

    try {
      await this.p.store.createApp(app);
    } catch (err) {
      // The unique index on (account, clientRef) is the create-dedup guard.
      // Losing that race means a concurrent identical push already created the
      // app, which is the answer we wanted anyway.
      if (app.clientRef !== '') {
        const existing = await this.p.store
          .appByClientRef(this.accountId, app.clientRef)
          .catch(() => null);
        if (existing !== null) return existing;
      }
      throw internal('create app', err);
    }
    return app;
  }

  // ---- PutBlob ----

  // The size the client sent (Content-Length) is deliberately ignored: the blob
  // store is framed to the size the open deploy's manifest declared, not to a
  // claim the caller controls.
  async putBlob(appId: string, digest: Digest, _size: number, body: BlobBody): Promise<void> {
    if (!validDigest(digest)) {
      throw new DeployErr({
        code: DeployCode.InvalidBlob,
        message: `"${digest}" is not a sha-256 digest`,
        fix: 'upgrade the 280 CLI, then run 280 push again',
      });
    }

    const app = await this.wrapInternal('look up app', () => this.p.store.app(this.accountId, appId));
    if (app === null) {
      throw new DeployErr({
        code: DeployCode.NoSuchApp,
        message: `app "${appId}" does not exist on this account`,
        fix: 'run 280 push again',
      });
    }

    // Idempotent re-send. Checked before the open-deploy test on purpose: a
    // retry that arrives after activation completed is a success, not a
    // protocol error.
    const has = await this.wrapInternal('check blob', () => this.p.blobs.has(appId, digest));
    if (has) return;

    const open = await this.wrapInternal('list open deploys', () => this.p.store.openDeploys(appId));
    // The manifest that named this blob also declared its size. Look both up in
    // one pass: an unwanted digest is rejected here (the upload endpoint is
    // never general storage), and a wanted one carries the declared size the
    // blob store frames the body to.
    const declared = declaredSize(open, digest);
    if (declared === null) {
      throw new DeployErr({
        code: DeployCode.InvalidBlob,
        message: `digest ${digest} is not named by any open deploy`,
        fix: 'run 280 push again',
      });
    }

    try {
      await this.p.blobs.put(appId, digest, declared, body);
    } catch (err) {
      const de = asDeployErr(err);
      if (de !== null) throw de;
      // A body that died mid-flight is transient and the blob is unchanged: the
      // CLI's answer is to send it again.
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'upload interrupted: ' + errText(err),
        retryable: true,
      });
    }

    // No activation verb exists. When the last blob lands the server finalizes
    // on its own, which is why there is nothing for an interrupted client to
    // forget to call.
    for (const dep of open) {
      await this.settle(app, dep);
    }
  }

  // ---- activation ----

  // settle hands a content-complete deploy to the app's activator and returns the
  // deploy's current state. It is the request-side half of activation: it checks
  // that the deploy is not already terminal and that its content is complete, then
  // enqueues the activation and reads back whatever the store now says.
  //
  // It does NOT claim the deploy. The claim (uploading -> activating) happens
  // inside the activator, so nothing can wedge in activating from a lost handoff:
  // if the enqueue is lost — this call throws, the handler dies, the isolate
  // evicts — the deploy is still uploading, and the existing self-heal loop
  // recovers it (the CLI re-syncs, this runs again, the activator is asked again).
  // Deploy ids are content-derived and the CLI's poll loop has no attempt cap, so
  // a deploy stuck in activating with no owner would be unrecoverable; keeping the
  // claim on the activator's side of a durable handoff is what rules that out.
  //
  // In production the enqueue returns before the runtime activation completes, so
  // the last blob's 204 ships ahead of the app going live; the CLI polls Status to
  // a terminal state as it always has.
  private async settle(app: App, dep: Deploy): Promise<Deploy> {
    if (stateTerminal(dep.state)) return dep;
    const missing = await this.wrapInternal('list missing blobs', () =>
      this.p.blobs.missing(app.id, manifestBlobs(dep.manifest)),
    );
    if (missing.length > 0) return dep;

    await this.wrapInternal('enqueue activation', () => this.p.activator.activate(app, dep.id));

    // Report whatever the store now says: uploading (production, activation still
    // in flight) or terminal (an inline activator that finished synchronously).
    const got = await this.wrapInternal('read deploy', () => this.p.store.deploy(app.id, dep.id));
    return got ?? dep;
  }

  // ---- Delete ----

  // The destructive tail runs through the activator (runtime, then content, then
  // the row, in that order — every step idempotent, each only meaningful while the
  // row still exists). Routing it through the same object activation goes through
  // is what keeps a push already past its last blob from re-uploading the worker
  // after this removes it: both serialize through one per-app object, and the
  // activation re-checks the app row inside it. Dry-run and confirmation stay here
  // in the request path.
  async delete(req: DeleteRequest): Promise<DeleteResult> {
    const app = await this.wrapInternal('look up app', () =>
      this.p.store.app(this.accountId, req.appId),
    );
    if (app === null) {
      throw new DeployErr({
        code: DeployCode.NoSuchApp,
        message: `app "${req.appId}" does not exist on this account`,
        fix: 'run 280 push to create it',
      });
    }

    // A dry run is how the CLI learns what it is about to destroy, so it must
    // touch nothing.
    if (req.confirm === '') {
      return { app: publicApp(app), deleted: false };
    }
    // The server's slug is the authority, not the client's config file: a stale
    // or hand-edited name must not be able to confirm a delete.
    if (req.confirm !== app.slug) {
      throw new DeployErr({
        code: DeployCode.ConfirmationRequired,
        message: `"${req.confirm}" does not name this app`,
        fix: 'run 280 delete --yes ' + app.slug,
      });
    }

    const deleted = await this.wrapInternal('delete app', () => this.p.activator.delete(app));
    return { app: publicApp(app), deleted };
  }

  // ---- Status ----

  async status(appId: string, deployId: string): Promise<DeployStatus> {
    const app = await this.wrapInternal('look up app', () => this.p.store.app(this.accountId, appId));
    if (app === null) throw notFound(appId, deployId);
    const dep = await this.wrapInternal('read deploy', () => this.p.store.deploy(appId, deployId));
    if (dep === null) throw notFound(appId, deployId);
    const st: DeployStatus = {
      state: dep.state,
      url: dep.state === State.Live ? app.url : '',
      failure: dep.failure ?? undefined,
    };
    return st;
  }

  // wrapInternal launders a store/blob fault into the seam's retryable error,
  // preserving a DeployErr thrown from below unchanged.
  private async wrapInternal<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const de = asDeployErr(err);
      if (de !== null) throw de;
      throw internal(what, err);
    }
  }
}

// ---- preflight ----

// preflight rejects manifests the substrate cannot run, before any state
// changes. Failing here rather than at request time is the whole point: a push
// that cannot work must not produce a broken app.
export function preflight(m: Manifest): void {
  if (m.kind !== MANIFEST_KIND_BUNDLE) {
    throw new DeployErr({
      code: DeployCode.PreflightRejected,
      message: `manifest kind "${m.kind}" is not supported; this platform serves "${MANIFEST_KIND_BUNDLE}"`,
      fix: 'upgrade the 280 CLI, then run 280 push again',
    });
  }
  // Manifest sizes are raw, so this is only the coarse half of the envelope
  // check: raw over the limit can never compress under it. The exact gzipped
  // limit is enforced at activation, where the bytes are.
  if (m.worker.size > MAX_WORKER_GZIP_BYTES) {
    throw new DeployErr({
      code: DeployCode.PreflightRejected,
      message: `worker is ${m.worker.size} raw bytes; the limit is ${MAX_WORKER_GZIP_BYTES}`,
      fix: 'shrink the server bundle, then run 280 push again',
    });
  }
  for (const a of m.assets) {
    if (!a.path.startsWith('/')) {
      throw new DeployErr({
        code: DeployCode.PreflightRejected,
        message: `asset path "${a.path}" is not absolute`,
        fix: 'upgrade the 280 CLI, then run 280 push again',
      });
    }
  }
  for (const c of m.cache) {
    checkCacheKey(c.path);
  }
  // Every digest reaches the blob store, which builds a filesystem path out of
  // it. Unchecked, a short digest panics on the fan-out slice and a crafted one
  // escapes the app's directory. PutBlob already rejects these; the manifest is
  // the other way in.
  for (const b of manifestBlobs(m)) {
    if (!validDigest(b.digest)) {
      throw new DeployErr({
        code: DeployCode.PreflightRejected,
        message: `"${b.digest}" is not a sha-256 digest`,
        fix: 'upgrade the 280 CLI, then run 280 push again',
      });
    }
  }
}

// maxCacheKeyBytes is the KV key limit the cache seed is written under.
const MAX_CACHE_KEY_BYTES = 512;

// checkCacheKey rejects what the cache namespace would. A cache path is a KV
// key, not a URL, so no leading slash is required. What is required is that the
// key survive the bulk write at activation.
function checkCacheKey(key: string): void {
  const reject = (why: string): never => {
    throw new DeployErr({
      code: DeployCode.PreflightRejected,
      message: 'cache key ' + why,
      fix: 'upgrade the 280 CLI, then run 280 push again',
    });
  };
  if (key === '') reject('is empty');
  // Length in bytes, matching Go len() over UTF-8.
  const bytes = Buffer.byteLength(key, 'utf8');
  if (bytes > MAX_CACHE_KEY_BYTES) {
    reject(`is ${bytes} bytes; the limit is ${MAX_CACHE_KEY_BYTES}`);
  }
  if (key.includes('\u0000') || key.includes('\n') || key.includes('\r')) {
    reject(`"${key}" contains a control character`);
  }
}

// declaredSize returns the size an open deploy's manifest declared for digest,
// or null when no open deploy names it. The size is the byte length the blob
// store frames the upload to; null is the "not named by any open deploy"
// rejection. The first match wins: a digest is content, so any manifest that
// names it declares the same size.
function declaredSize(open: Deploy[], digest: Digest): number | null {
  for (const d of open) {
    for (const b of manifestBlobs(d.manifest)) {
      if (b.digest === digest) return b.size;
    }
  }
  return null;
}

function notFound(appId: string, deployId: string): DeployErr {
  return new DeployErr({
    code: DeployCode.NotFound,
    message: `deploy "${deployId}" not found for app "${appId}"`,
    fix: 'run 280 push again',
  });
}

// ---- naming / derivations (deploysvc.go). Proven against golden vectors. ----

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

// deriveDeployId makes the deploy id a pure function of what is being deployed.
// No client-generated key, and therefore no resume journal (deploysvc.go:586).
export function deriveDeployId(appId: string, m: Manifest): string {
  return 'dep_' + digestBytes(utf8(appId + ':' + canonicalDigest(m))).slice(0, 16);
}

// fingerprint is the project identity used for autolink. The raw git remote
// never lands in the database (deploysvc.go:592).
export function fingerprint(gitRemote: string, slug: string): string {
  return digestBytes(utf8('fp:' + gitRemote + ':' + slug));
}

// urlToken is the unguessable half of an app URL: 10 base36 characters derived
// from the app id. seed is the hex-string digest; seed[i] is an ASCII hex char
// (deploysvc.go:601).
export function urlToken(appId: string): string {
  const seed = digestBytes(utf8('token:' + appId));
  let tok = '';
  for (let i = 0; i < 10; i++) {
    tok += BASE36[seed.charCodeAt(i) % BASE36.length];
  }
  return tok;
}

const NOT_SLUG_CHAR = /[^a-z0-9]+/g;

// sanitizeSlug reduces a project name to something legal as both a hostname
// label and a runtime script name (deploysvc.go:614).
export function sanitizeSlug(raw: string): string {
  let s = raw.toLowerCase().replace(NOT_SLUG_CHAR, '-');
  s = trimDash(s);
  if (s.length > 40) {
    s = trimDash(s.slice(0, 40));
  }
  if (s === '') s = 'app';
  return s;
}

function trimDash(s: string): string {
  return s.replace(/^-+/, '').replace(/-+$/, '');
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function validDigest(d: Digest): boolean {
  return DIGEST_RE.test(d);
}

function randomHex(n: number): string {
  return randomBytes(n).toString('hex');
}

function publicApp(a: App): PublicApp {
  return { id: a.id, slug: a.slug, url: a.url };
}

function utf8(s: string): Uint8Array {
  return Buffer.from(s, 'utf8');
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// internal wraps a server-side fault as the seam's retryable error. The agent
// never sees our stack; it sees "try again".
export function internal(what: string, err: unknown): DeployErr {
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `${what}: ${errText(err)}`,
    retryable: true,
  });
}
