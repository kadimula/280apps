// The in-memory adapter of Port. It is the executable contract: the CLI's push
// logic is developed and tested against it, and the conformance suite holds it
// and the real service to the same behavior. Fault-injection knobs simulate the
// failure modes push must self-heal from.
//
// Spec: contracts/deploy/fake.go. Go is normative, including FailNext /
// DropBodyAfter / FailActivation and the atomic single-pointer activation.

import {
  DeployCode,
  MAX_WORKER_GZIP_BYTES,
  Resolution,
  State,
  stateTerminal,
  digestBytes,
  manifestBlobs,
  canonicalDigest,
  type App,
  type Digest,
  type Identity,
  type Manifest,
  type Resolution as ResolutionT,
  type SyncRequest,
  type SyncResult,
  type DeployStatus,
  type DeleteRequest,
  type DeleteResult,
} from '../index.js';
import type { Port, BlobBody } from '../port.js';
import { DeployErr } from './error.js';

interface FakeDeploy {
  appId: string;
  id: string;
  manifest: Manifest;
  state: string;
  failure?: DeployErr;
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function fingerprint(gitRemote: string, slug: string): string {
  return digestBytes(Buffer.from('fp:' + gitRemote + ':' + slug, 'utf8'));
}

function deriveDeployId(appId: string, m: Manifest): string {
  return 'dep_' + digestBytes(Buffer.from(appId + ':' + canonicalDigest(m), 'utf8')).slice(0, 16);
}

// urlToken indexes the hex-string digest (seed[i] is an ASCII hex char), not
// raw sha256 bytes (plan §10 parity trap; fake.go:99).
function urlToken(appId: string): string {
  const seed = digestBytes(Buffer.from('token:' + appId, 'utf8'));
  let tok = '';
  for (let i = 0; i < 10; i++) {
    tok += BASE36[seed.charCodeAt(i) % BASE36.length];
  }
  return tok;
}

// byteLess orders two strings by their UTF-8 bytes, matching Go's string <.
function byteLess(a: string, b: string): boolean {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) < 0;
}

export class Fake implements Port {
  private readonly urlBase = '280apps.run';
  private nextApp = 0;

  private readonly apps = new Map<string, App>();
  private readonly byFingerprint = new Map<string, string[]>(); // fingerprint -> app ids, creation order
  private readonly byClientRef = new Map<string, string>();
  private readonly blobs = new Map<string, Map<Digest, Uint8Array>>(); // app id -> stored blobs
  private readonly deploys = new Map<string, FakeDeploy>(); // "appId/deployId" -> deploy
  private readonly active = new Map<string, string>(); // app id -> live deploy id

  private pendingFailNext = 0; // next N port calls fail retryable
  private pendingDropBodyAfter = -1; // one-shot: PutBlob loses the connection after this many bytes (-1 off)
  private pendingFailActivation = false; // one-shot: next activation fails the deploy

  // failNext makes the next n port calls fail with a retryable unavailable error
  // before doing any work (fake.go FailNext).
  failNext(n: number): void {
    this.pendingFailNext = n;
  }

  // dropBodyAfter makes the next PutBlob whose size exceeds n read n bytes and
  // then fail retryable, storing nothing — a connection dying mid-upload
  // (fake.go DropBodyAfter).
  dropBodyAfter(n: number): void {
    this.pendingDropBodyAfter = n;
  }

  // failActivation makes the next activation mark the deploy failed instead of
  // flipping the serving pointer (fake.go FailActivation).
  failActivation(): void {
    this.pendingFailActivation = true;
  }

  // ActiveDeployID reports which deploy the app is serving — the fake's stand-in
  // for GETting the app URL. Empty until first activation.
  activeDeployId(appId: string): string {
    return this.active.get(appId) ?? '';
  }

  // AppCount reports how many apps exist on the account.
  appCount(): number {
    return this.apps.size;
  }

  private fault(): DeployErr | undefined {
    if (this.pendingFailNext > 0) {
      this.pendingFailNext--;
      return new DeployErr({
        code: DeployCode.Unavailable,
        message: 'service unavailable',
        retryable: true,
      });
    }
    return undefined;
  }

  private resolve(id: Identity): { app: App; resolution: ResolutionT } {
    if (id.appId !== '') {
      const app = this.apps.get(id.appId);
      if (!app) {
        throw new DeployErr({
          code: DeployCode.NoSuchApp,
          message: `app ${quote(id.appId)} does not exist on this account`,
          fix: 'run 280 list, then 280 link <app-id>, or 280 push --new',
        });
      }
      return { app, resolution: Resolution.Existing };
    }
    if (!id.forceNew) {
      if (id.gitRemote !== '') {
        const matches = this.byFingerprint.get(fingerprint(id.gitRemote, id.slug)) ?? [];
        if (matches.length === 1) {
          return { app: this.apps.get(matches[0]!)!, resolution: Resolution.FingerprintLinked };
        }
        if (matches.length > 1) {
          throw new DeployErr({
            code: DeployCode.AmbiguousIdentity,
            message: `${matches.length} apps match this project`,
            fix: 'run 280 link <app-id> to pick one, or 280 push --new',
            candidates: [...matches],
          });
        }
      }
      if (id.clientRef !== '') {
        const appId = this.byClientRef.get(id.clientRef);
        if (appId !== undefined) {
          return { app: this.apps.get(appId)!, resolution: Resolution.Existing };
        }
      }
    }
    this.nextApp++;
    const appId = `app_${String(this.nextApp).padStart(6, '0')}`;
    const app: App = {
      id: appId,
      slug: id.slug,
      url: `https://${id.slug}-${urlToken(appId)}.${this.urlBase}`,
    };
    this.apps.set(app.id, app);
    this.blobs.set(app.id, new Map());
    if (id.gitRemote !== '') {
      const fp = fingerprint(id.gitRemote, id.slug);
      this.byFingerprint.set(fp, [...(this.byFingerprint.get(fp) ?? []), app.id]);
    }
    if (id.clientRef !== '') {
      this.byClientRef.set(id.clientRef, app.id);
    }
    return { app, resolution: Resolution.Created };
  }

  private missing(d: FakeDeploy): Digest[] {
    const have = this.blobs.get(d.appId) ?? new Map<Digest, Uint8Array>();
    const seen = new Set<Digest>();
    const out: Digest[] = [];
    for (const b of manifestBlobs(d.manifest)) {
      if (!have.has(b.digest) && !seen.has(b.digest)) {
        seen.add(b.digest);
        out.push(b.digest);
      }
    }
    out.sort((a, b) => (byteLess(a, b) ? -1 : byteLess(b, a) ? 1 : 0));
    return out;
  }

  // maybeActivate finalizes a content-complete open deploy: the single atomic
  // serving-pointer flip. There is no client-visible activation verb.
  private maybeActivate(d: FakeDeploy): void {
    if (stateTerminal(d.state) || this.missing(d).length > 0) {
      return;
    }
    if (this.pendingFailActivation) {
      this.pendingFailActivation = false;
      d.state = State.Failed;
      d.failure = new DeployErr({
        code: DeployCode.Unavailable,
        message: 'activation failed on the platform',
        fix: 'run 280 push again',
      });
      return;
    }
    d.state = State.Live;
    this.active.set(d.appId, d.id);
    // One live deploy per app: the one being served. Deploy ids derive from
    // content, so a revert re-pushes an id that was live before; a stale live
    // row would read as terminal here and never re-activate.
    for (const [key, other] of this.deploys) {
      if (other.appId === d.appId && other.id !== d.id && other.state === State.Live) {
        this.deploys.delete(key);
      }
    }
  }

  async sync(req: SyncRequest): Promise<SyncResult> {
    const fault = this.fault();
    if (fault) throw fault;
    const { app, resolution } = this.resolve(req.identity);
    if (req.manifest.worker.size > MAX_WORKER_GZIP_BYTES) {
      throw new DeployErr({
        code: DeployCode.PreflightRejected,
        message: `worker is ${req.manifest.worker.size} raw bytes; the limit is ${MAX_WORKER_GZIP_BYTES}`,
        fix: 'shrink the server bundle, then run 280 push again',
      });
    }
    const deployId = deriveDeployId(app.id, req.manifest);
    const key = app.id + '/' + deployId;
    let d = this.deploys.get(key);
    if (!d) {
      d = { appId: app.id, id: deployId, manifest: req.manifest, state: State.Uploading };
      this.deploys.set(key, d);
    }
    if (d.state === State.Failed) {
      // failure is attempt-scoped; re-Sync reopens
      d.state = State.Uploading;
      d.failure = undefined;
    }
    this.maybeActivate(d);
    return {
      app: { ...app },
      resolution,
      deployId,
      state: d.state,
      missing: this.missing(d),
      failure: errObj(d.failure),
    };
  }

  private blobWanted(appId: string, digest: Digest): boolean {
    for (const d of this.deploys.values()) {
      if (d.appId !== appId || stateTerminal(d.state)) continue;
      for (const b of manifestBlobs(d.manifest)) {
        if (b.digest === digest) return true;
      }
    }
    return false;
  }

  async putBlob(appId: string, digest: Digest, size: number, body: BlobBody): Promise<void> {
    const fault = this.fault();
    if (fault) throw fault;
    const store = this.blobs.get(appId);
    if (!store) {
      throw new DeployErr({
        code: DeployCode.NoSuchApp,
        message: `app ${quote(appId)} does not exist on this account`,
        fix: 'run 280 push again',
      });
    }
    if (store.has(digest)) {
      return; // idempotent re-send
    }
    if (!this.blobWanted(appId, digest)) {
      throw new DeployErr({
        code: DeployCode.InvalidBlob,
        message: `digest ${digest} is not named by any open deploy`,
        fix: 'run 280 push again',
      });
    }
    if (this.pendingDropBodyAfter >= 0 && size > this.pendingDropBodyAfter) {
      await readN(body, this.pendingDropBodyAfter);
      this.pendingDropBodyAfter = -1;
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'connection reset during upload',
        retryable: true,
      });
    }
    let b: Uint8Array;
    try {
      b = await readAll(body);
    } catch (err) {
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: 'upload interrupted: ' + errMessage(err),
        retryable: true,
      });
    }
    if (digestBytes(b) !== digest) {
      throw new DeployErr({
        code: DeployCode.DigestMismatch,
        message:
          'uploaded bytes do not match the declared digest; the build output changed underneath the push',
        fix: 'run 280 push again',
      });
    }
    store.set(digest, b);
    for (const d of this.deploys.values()) {
      if (d.appId === appId) this.maybeActivate(d);
    }
  }

  async status(appId: string, deployId: string): Promise<DeployStatus> {
    const fault = this.fault();
    if (fault) throw fault;
    const d = this.deploys.get(appId + '/' + deployId);
    if (!d) {
      throw new DeployErr({
        code: DeployCode.NotFound,
        message: `deploy ${quote(deployId)} not found for app ${quote(appId)}`,
        fix: 'run 280 push again',
      });
    }
    const st: DeployStatus = { state: d.state, url: '', failure: errObj(d.failure) };
    if (d.state === State.Live) {
      st.url = this.apps.get(appId)!.url;
    }
    return st;
  }

  async delete(req: DeleteRequest): Promise<DeleteResult> {
    const fault = this.fault();
    if (fault) throw fault;
    const app = this.apps.get(req.appId);
    if (!app) {
      throw new DeployErr({
        code: DeployCode.NoSuchApp,
        message: `app ${quote(req.appId)} does not exist on this account`,
        fix: 'run 280 push to create it',
      });
    }
    if (req.confirm === '') {
      return { app: { ...app }, deleted: false };
    }
    if (req.confirm !== app.slug) {
      throw new DeployErr({
        code: DeployCode.ConfirmationRequired,
        message: `${quote(req.confirm)} does not name this app`,
        fix: 'run 280 delete --yes ' + app.slug,
      });
    }

    const gone = { ...app };
    this.apps.delete(app.id);
    this.blobs.delete(app.id);
    this.active.delete(app.id);
    for (const [key, d] of this.deploys) {
      if (d.appId === app.id) this.deploys.delete(key);
    }
    // The identity indexes go too, or the next push of the same project would
    // autolink onto an app that no longer exists.
    for (const [fp, ids] of this.byFingerprint) {
      const kept = ids.filter((id) => id !== app.id);
      if (kept.length === 0) {
        this.byFingerprint.delete(fp);
        continue;
      }
      this.byFingerprint.set(fp, kept);
    }
    for (const [ref, id] of this.byClientRef) {
      if (id === app.id) this.byClientRef.delete(ref);
    }
    return { app: gone, deleted: true };
  }
}

// quote mirrors Go's %q on a string: double-quoted, with the escaping Go's
// strconv.Quote applies to the inputs this seam carries (app ids, slugs, user
// input). For the ASCII identifiers here it is a plain double-quote wrap.
function quote(s: string): string {
  return JSON.stringify(s);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// errObj renders a thrown DeployErr as the plain wire error shape the server
// puts in SyncResult.Failure / DeployStatus.Failure (deploy.go Error). Undefined
// when there is no failure, matching Go's omitempty *Error.
function errObj(e: DeployErr | undefined) {
  if (!e) return undefined;
  return { code: e.code, message: e.message, fix: e.fix, retryable: e.retryable, candidates: e.candidates };
}

// ---- body helpers: BlobBody is a Node Readable or an async iterable ----

async function readAll(body: BlobBody): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(asBytes(chunk));
  }
  return Buffer.concat(chunks);
}

// readN consumes up to n bytes then stops reading, mirroring io.CopyN into
// discard: the connection dies after n bytes and the rest is never read.
async function readN(body: BlobBody, n: number): Promise<void> {
  let read = 0;
  if (n <= 0) return;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    read += asBytes(chunk).length;
    if (read >= n) return;
  }
}

function asBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return chunk as Uint8Array;
}
