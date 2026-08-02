// deploysvc is the server side of the deploy seam: the contracts deploy Port the
// HTTP API is a thin transport over. Go is normative (deploysvc.go), including the
// invariant that methods are idempotent and safe to re-invoke — nothing here holds
// state between calls.

import {
  APP_ROLE_ORDER,
  DeployCode,
  DeployErr,
  MANIFEST_KIND_CONTAINER,
  MAX_BUILD_CONTEXT_BYTES,
  Resolution,
  State,
  canonicalDigest,
  digestBytes,
  isAppAccess,
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

// deployShaped duck-types a caught value into the seam's plain error fields: the
// blob store (W4) throws its own DeployErr subclass with the same shape but a
// different identity, so `instanceof` alone would miss it.
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

// asDeployErr returns a canonical DeployErr for a deploy-shaped caught value, so a
// seam error thrown by a different workstream's class rethrows as our type.
export function asDeployErr(err: unknown): DeployErr | null {
  const s = deployShaped(err);
  return s === null ? null : new DeployErr(s);
}

// Platform is the user-independent half: storage, config, and the activator.
export interface PlatformDeps {
  store: Store;
  blobs: BlobStore;
  // activator serializes and executes one app's activation and delete.
  activator: Activator;
  // appDomain is the zone app URLs live on, e.g. "280apps.run".
  appDomain: string;
  // hostSuffix is appended to an app's URL host label (not its script name), so
  // staging can emit first-level suffix hostnames like "<slug>-<token>-staging..."
  // that free Universal SSL still covers. Empty reproduces Go byte for byte.
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

  // The Port scoped to a user: the user is a field, not a parameter, so a query
  // that forgets to scope by user is not expressible.
  for(userId: string): Service {
    return new Service(this, userId);
  }
}

// Service implements the deploy Port for one authenticated user.
export class Service implements Port {
  constructor(
    private readonly p: Platform,
    private readonly userId: string,
  ) {}

  async sync(req: SyncRequest): Promise<SyncResult> {
    // Preflight first: rejecting the manifest must change no state, so it happens
    // before the app is created.
    preflight(req.manifest);

    const { app, resolution } = await this.resolve(req.identity);

    // The request is its own idempotency key: same app + same manifest content means
    // the same deploy, so a retried push resumes instead of forking.
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

  // resolve maps an Identity onto an app, creating one if nothing matches. The order
  // is the contract's: explicit id, then fingerprint autolink, then clientRef, then
  // create.
  private async resolve(id: Identity): Promise<{ app: App; resolution: string }> {
    if (id.appId !== '') {
      const app = await this.wrapInternal('look up app', () =>
        this.p.store.app(this.userId, id.appId),
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
          this.p.store.appsByFingerprint(this.userId, fingerprint(id.gitRemote, id.slug)),
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
          this.p.store.appByClientRef(this.userId, id.clientRef),
        );
        if (app !== null) {
          return { app, resolution: Resolution.Existing };
        }
      }
    }

    const app = await this.createApp(id);
    return { app, resolution: Resolution.Created };
  }

  // createApp allocates an app's permanent identity: id, script name, URL, and asset
  // salt. None ever change, which is what makes an app's URL survive every redeploy.
  private async createApp(id: Identity): Promise<App> {
    const slug = sanitizeSlug(id.slug);
    const appId = 'app_' + randomHex(6);
    // The script name is the app's environment-independent identity in the dispatch
    // namespace; the host suffix rides only on the URL host label, which staging
    // strips back to this bare name for lookup.
    const script = slug + '-' + urlToken(appId);

    const app: App = {
      id: appId,
      userId: this.userId,
      slug,
      framework: id.framework,
      script,
      url: 'https://' + script + this.p.hostSuffix + '.' + this.p.appDomain,
      salt: randomHex(16),
      fingerprint: id.gitRemote !== '' ? fingerprint(id.gitRemote, slug) : '',
      // --new must always create, so it must not claim the nonce that would make the
      // next push dedupe onto this app.
      clientRef: id.forceNew ? '' : id.clientRef,
      storeId: '',
      activeDeploy: '',
    };

    try {
      await this.p.store.createApp(app);
    } catch (err) {
      // The unique index on (account, clientRef) is the create-dedup guard. Losing
      // that race means a concurrent identical push already created the app, which
      // is the answer we wanted anyway.
      if (app.clientRef !== '') {
        const existing = await this.p.store
          .appByClientRef(this.userId, app.clientRef)
          .catch(() => null);
        if (existing !== null) return existing;
      }
      throw internal('create app', err);
    }
    return app;
  }

  // The client's Content-Length (_size) is deliberately ignored: the blob store is
  // framed to the size the open deploy's manifest declared, not a caller's claim.
  async putBlob(appId: string, digest: Digest, _size: number, body: BlobBody): Promise<void> {
    if (!validDigest(digest)) {
      throw new DeployErr({
        code: DeployCode.InvalidBlob,
        message: `"${digest}" is not a sha-256 digest`,
        fix: 'upgrade the 280 CLI, then run 280 push again',
      });
    }

    const app = await this.wrapInternal('look up app', () => this.p.store.app(this.userId, appId));
    if (app === null) {
      throw new DeployErr({
        code: DeployCode.NoSuchApp,
        message: `app "${appId}" does not exist on this account`,
        fix: 'run 280 push again',
      });
    }

    // Idempotent re-send, checked before the open-deploy test: a retry arriving after
    // activation completed is a success, not a protocol error.
    const has = await this.wrapInternal('check blob', () => this.p.blobs.has(appId, digest));
    if (has) return;

    const open = await this.wrapInternal('list open deploys', () => this.p.store.openDeploys(appId));
    // An unwanted digest is rejected here (the upload endpoint is never general
    // storage); a wanted one carries the size its manifest declared.
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
      // A body that died mid-flight is transient and the blob is unchanged: the CLI's
      // answer is to send it again.
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'upload interrupted: ' + errText(err),
        retryable: true,
      });
    }

    // No activation verb exists: when the last blob lands the server finalizes on its
    // own, so there is nothing for an interrupted client to forget to call.
    for (const dep of open) {
      await this.settle(app, dep);
    }
  }

  // settle hands a content-complete deploy to the app's activator and reads back its
  // current state. It does NOT claim the deploy: the claim (uploading -> activating)
  // happens inside the activator, so a lost enqueue leaves the deploy uploading for
  // the self-heal loop rather than wedged in activating with no owner.
  private async settle(app: App, dep: Deploy): Promise<Deploy> {
    if (stateTerminal(dep.state)) return dep;
    const missing = await this.wrapInternal('list missing blobs', () =>
      this.p.blobs.missing(app.id, manifestBlobs(dep.manifest)),
    );
    if (missing.length > 0) return dep;

    await this.wrapInternal('enqueue activation', () => this.p.activator.activate(app, dep.id));

    // Whatever the store now says: uploading (activation in flight) or terminal.
    const got = await this.wrapInternal('read deploy', () => this.p.store.deploy(app.id, dep.id));
    return got ?? dep;
  }

  // The destructive tail runs through the activator (runtime, then content, then the
  // row, each idempotent and meaningful only while the row exists). Routing it
  // through the same per-app serialization keeps a push past its last blob from
  // re-uploading the worker after this removes it. Dry-run and confirmation stay here.
  async delete(req: DeleteRequest): Promise<DeleteResult> {
    const app = await this.wrapInternal('look up app', () =>
      this.p.store.app(this.userId, req.appId),
    );
    if (app === null) {
      throw new DeployErr({
        code: DeployCode.NoSuchApp,
        message: `app "${req.appId}" does not exist on this account`,
        fix: 'run 280 push to create it',
      });
    }

    // A dry run is how the CLI learns what it is about to destroy, so it touches
    // nothing.
    if (req.confirm === '') {
      return { app: publicApp(app), deleted: false };
    }
    // The server's slug is the authority, not the client's config file: a stale or
    // hand-edited name must not be able to confirm a delete.
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

  async status(appId: string, deployId: string): Promise<DeployStatus> {
    const app = await this.wrapInternal('look up app', () => this.p.store.app(this.userId, appId));
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

// preflight rejects manifests the substrate cannot build, before any state
// changes. Failing here rather than at request time is the whole point: a push
// that cannot work must not produce a broken app.
export function preflight(m: Manifest): void {
  const reject = (message: string): never => {
    throw new DeployErr({
      code: DeployCode.PreflightRejected,
      message,
      fix: 'upgrade the 280 CLI, then run 280 push again',
    });
  };
  if (m.kind !== MANIFEST_KIND_CONTAINER) {
    reject(`manifest kind "${m.kind}" is not supported; this platform serves "${MANIFEST_KIND_CONTAINER}"`);
  }
  if (m.build.dockerfile === '' || !m.files.some((f) => f.path === m.build.dockerfile)) {
    reject('the build context does not include its Dockerfile');
  }
  let total = 0;
  for (const f of m.files) {
    checkContextPath(f.path, reject);
    // Every digest reaches the blob store, which builds a filesystem path out of
    // it. Unchecked, a short digest panics on the fan-out slice and a crafted one
    // escapes the app's directory. PutBlob already rejects these; the manifest is
    // the other way in.
    if (!validDigest(f.digest)) reject(`"${f.digest}" is not a sha-256 digest`);
    total += f.size;
  }
  // Raw sizes, so this is the coarse guard: a context whose declared bytes exceed
  // the budget can never fit, and rejecting here avoids uploading it at all.
  if (total > MAX_BUILD_CONTEXT_BYTES) {
    reject(`build context is ${total} bytes; the limit is ${MAX_BUILD_CONTEXT_BYTES}`);
  }

  // The access policy is enforced, so a malformed one must fail closed here rather
  // than register a policy the gateway would misread. The CLI validates the human
  // 280.json too; this is the server-side backstop that does not trust the client.
  preflightPolicy(m.access ?? '', m.roles ?? [], m.routes ?? [], reject);
}

// preflightPolicy rejects an access mode the platform does not enforce, a route with
// no path or an incoherent requirement, or a route that gates on a feature role the
// manifest never declared (a typo that would otherwise silently fail closed).
function preflightPolicy(
  access: string,
  roles: string[],
  routes: Array<{ path: string; appRole: string; role: string }>,
  reject: (why: string) => never,
): void {
  if (access !== '' && !isAppAccess(access)) {
    reject(`access "${access}" is not one of invited, anyone-at-tenant, link`);
  }
  const known = new Set(roles.filter((r) => r !== ''));
  for (const g of routes) {
    if (g.path === '') reject('a route gate has an empty path');
    const hasAppRole = g.appRole !== '';
    const hasRole = g.role !== '';
    if (!hasAppRole && !hasRole) reject(`route "${g.path}" declares no requirement (need an app_role or role)`);
    if (hasAppRole && hasRole) reject(`route "${g.path}" sets both app_role and role; pick one`);
    if (hasAppRole && !(APP_ROLE_ORDER as readonly string[]).includes(g.appRole)) {
      reject(`route "${g.path}" app_role "${g.appRole}" is not one of ${APP_ROLE_ORDER.join(', ')}`);
    }
    if (hasRole && !known.has(g.role)) {
      reject(`route "${g.path}" requires role "${g.role}", which is not in this app's declared roles`);
    }
  }
}

// checkContextPath refuses a build-context path the runtime could not safely
// materialize: it must be relative and stay inside the context root, so a leading
// slash or a ".." segment (which would escape the build directory) is rejected —
// a path-traversal guard, not a style rule.
function checkContextPath(path: string, reject: (why: string) => never): void {
  if (path === '') reject('a build-context file has an empty path');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    reject(`context path "${path}" is not relative`);
  }
  for (const seg of path.split(/[\\/]/)) {
    if (seg === '..') reject(`context path "${path}" escapes the build context`);
  }
}

// declaredSize returns the size an open deploy's manifest declared for digest, or
// null when no open deploy names it. First match wins: a digest is content, so any
// manifest naming it declares the same size.
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

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

// deriveDeployId makes the deploy id a pure function of what is being deployed. No
// client-generated key, and therefore no resume journal.
export function deriveDeployId(appId: string, m: Manifest): string {
  return 'dep_' + digestBytes(utf8(appId + ':' + canonicalDigest(m))).slice(0, 16);
}

// fingerprint is the project identity used for autolink. The raw git remote never
// lands in the database.
export function fingerprint(gitRemote: string, slug: string): string {
  return digestBytes(utf8('fp:' + gitRemote + ':' + slug));
}

// urlToken is the unguessable half of an app URL: 10 base36 characters derived from
// the app id.
export function urlToken(appId: string): string {
  const seed = digestBytes(utf8('token:' + appId));
  let tok = '';
  for (let i = 0; i < 10; i++) {
    tok += BASE36[seed.charCodeAt(i) % BASE36.length];
  }
  return tok;
}

const NOT_SLUG_CHAR = /[^a-z0-9]+/g;

// sanitizeSlug reduces a project name to something legal as both a hostname label
// and a runtime script name.
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

// internal wraps a server-side fault as the seam's retryable error. The agent never
// sees our stack; it sees "try again".
export function internal(what: string, err: unknown): DeployErr {
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `${what}: ${errText(err)}`,
    retryable: true,
  });
}
