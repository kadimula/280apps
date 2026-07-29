// The deploy seam's behavioral test suite. Every adapter of Port must pass it:
// Fake in unit tests, and the production HTTP adapter pointed at the real
// service in integration. Drift between fake and service is a failing build,
// which is what keeps the fake an executable contract rather than a stale stub.
//
// Spec: contracts/deploy/conformance/conformance.go. Go is normative — all 20
// named cases, the URL regex, and wantCode asserting a fix on every
// non-retryable error are ported exactly.
//
// This module is framework-agnostic: it exports `cases`, an array of named
// checks that throw on failure. A test file registers them with its runner, and
// the same array runs against the fake (unit) and the HTTP client (integration,
// via TWO80_CONFORMANCE_URL) with no change here.

import {
  Resolution,
  State,
  stateTerminal,
  digestBytes,
  canonicalDigest,
  MANIFEST_KIND_BUNDLE,
  MAX_WORKER_GZIP_BYTES,
  DeployCode,
  type Digest,
  type Identity,
  type Manifest,
  type SyncResult,
} from '../index.js';
import type { Port } from '../port.js';
import { Readable } from 'node:stream';
import { asDeployError, type DeployErr } from './error.js';

// MakePort returns a fresh, empty Port (an empty account) for one case.
export type MakePort = () => Port;

export interface ConformanceCase {
  name: string;
  run: (mk: MakePort) => Promise<void>;
}

// ---- assertion + error helpers ----

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function q(s: string): string {
  return JSON.stringify(s);
}

// wantCode runs fn expecting it to reject with the seam's typed error carrying
// code, and enforces the same invariants Go's wantCode does: non-empty message,
// and a fix on every non-retryable error (conformance.go:143).
async function wantCode(fn: () => Promise<unknown>, code: string): Promise<DeployErr> {
  let err: unknown;
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  assert(threw, `want error code ${q(code)}, got nil`);
  const de = asDeployError(err);
  assert(de !== undefined, `want DeployErr, got ${String(err)}`);
  assert(de.code === code, `want code ${q(code)}, got ${q(de.code)} (${de.message})`);
  assert(de.message !== '', `error ${q(de.code)} has empty message`);
  assert(de.retryable || de.fix !== '', `non-retryable error ${q(de.code)} must carry a fix`);
  return de;
}

// ---- bundle + identity helpers (conformance.go:44) ----

interface Bundle {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
}

function bytes(s: string): Uint8Array {
  return Buffer.from(s, 'utf8');
}

function mkBundle(worker: Uint8Array, assets: Record<string, Uint8Array> | null): Bundle {
  return mkCacheBundle(worker, assets, null);
}

// mkCacheBundle is mkBundle plus a prerendered cache seed, keyed the way the
// adapter emits it ("<buildId>/<route>.cache") rather than by URL path.
function mkCacheBundle(
  worker: Uint8Array,
  assets: Record<string, Uint8Array> | null,
  cache: Record<string, Uint8Array> | null,
): Bundle {
  const content = new Map<Digest, Uint8Array>();
  const wd = digestBytes(worker);
  content.set(wd, worker);
  const manifest: Manifest = {
    kind: MANIFEST_KIND_BUNDLE,
    worker: { path: '', digest: wd, size: worker.length },
    assets: [],
    cache: [],
  };
  for (const [path, data] of Object.entries(assets ?? {})) {
    const d = digestBytes(data);
    content.set(d, data);
    manifest.assets.push({ path, digest: d, size: data.length });
  }
  for (const [key, data] of Object.entries(cache ?? {})) {
    const d = digestBytes(data);
    content.set(d, data);
    manifest.cache.push({ path: key, digest: d, size: data.length });
  }
  return { manifest, content };
}

function identity(slug: string, remote: string): Identity {
  return { appId: '', slug, framework: 'next', gitRemote: remote, clientRef: '', forceNew: false };
}

// bodyOf yields the blob as one Uint8Array chunk (a Node Readable), the streamed
// form PutBlob consumes. A fresh stream per call, exactly as Go's bytes.Reader.
function bodyOf(data: Uint8Array): Readable {
  return Readable.from([Buffer.from(data)]);
}

async function mustSync(p: Port, id: Identity, m: Manifest): Promise<SyncResult> {
  return p.sync({ identity: id, manifest: m });
}

async function putAll(p: Port, appId: string, missing: Digest[], b: Bundle): Promise<void> {
  for (const d of missing) {
    const data = b.content.get(d);
    assert(data !== undefined, `server asked for digest ${d} the manifest never declared`);
    await p.putBlob(appId, d, data.length, bodyOf(data));
  }
}

// pushToLive runs the exact loop the CLI runs: Sync, upload missing, poll.
async function pushToLive(p: Port, id: Identity, b: Bundle): Promise<SyncResult> {
  const res = await mustSync(p, id, b.manifest);
  await putAll(p, res.app.id, res.missing, b);
  await waitLive(p, res.app.id, res.deployId);
  return res;
}

// waitLive polls until the deploy activates, which the platform does on its own
// once the last blob lands.
async function waitLive(p: Port, appId: string, deployId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const st = await p.status(appId, deployId);
    assert(st.state !== State.Failed, `deploy failed: ${JSON.stringify(st.failure)}`);
    if (st.state === State.Live) return;
  }
  throw new Error('deploy never reached live');
}

function hasDigest(list: Digest[], want: Digest): boolean {
  return list.includes(want);
}

// URL scheme (conformance.go:164): <slug>-<10 base36>.<domain>.
const urlRe = /^https:\/\/[a-z0-9-]+-[a-z0-9]{10}\.[a-z0-9.-]+$/;

// ---- the 20 cases, in the order conformance.go registers them ----

export const cases: ConformanceCase[] = [
  {
    name: 'CreateOnFirstSync',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), { '/a.js': bytes('a') });
      const res = await mustSync(p, identity('demo', 'git@github.com:x/demo.git'), b.manifest);
      assert(res.resolution === Resolution.Created, `resolution = ${q(res.resolution)}, want created`);
      assert(res.app.id !== '' && res.deployId !== '', `empty app or deploy id: ${JSON.stringify(res)}`);
      assert(urlRe.test(res.app.url), `URL ${q(res.app.url)} does not match the app URL scheme`);
      assert(
        res.missing.length === b.content.size,
        `missing = ${res.missing.length} blobs, want all ${b.content.size}`,
      );
    },
  },
  {
    name: 'SyncIsIdempotent',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), { '/a.js': bytes('a') });
      const id = identity('demo', 'git@github.com:x/demo.git');
      const first = await mustSync(p, id, b.manifest);
      id.appId = first.app.id; // as the CLI persists it
      const again = await mustSync(p, id, b.manifest);
      assert(
        again.app.id === first.app.id && again.deployId === first.deployId,
        `re-Sync changed identity: ${JSON.stringify(again)} vs ${JSON.stringify(first)}`,
      );
      assert(
        again.missing.length === first.missing.length,
        `missing changed with no uploads: ${again.missing} vs ${first.missing}`,
      );
    },
  },
  {
    name: 'UploadAllThenLive',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), { '/a.js': bytes('a'), '/b.css': bytes('b') });
      const res = await pushToLive(p, identity('demo', 'git@github.com:x/demo.git'), b);
      // Re-put after live: idempotent no-op.
      const d = b.manifest.worker.digest;
      await p.putBlob(res.app.id, d, b.manifest.worker.size, bodyOf(b.content.get(d)!));
      const st = await p.status(res.app.id, res.deployId);
      assert(st.state === State.Live && st.url !== '', `want live with URL, got ${JSON.stringify(st)}`);
    },
  },
  {
    name: 'MissingShrinksAsBlobsLand',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), { '/a.js': bytes('a'), '/b.css': bytes('b') });
      const id = identity('demo', 'git@github.com:x/demo.git');
      const res = await mustSync(p, id, b.manifest);
      const one = res.missing[0]!;
      await putAll(p, res.app.id, [one], b);
      id.appId = res.app.id;
      const again = await mustSync(p, id, b.manifest);
      assert(
        again.missing.length === res.missing.length - 1,
        `missing = ${again.missing.length}, want ${res.missing.length - 1}`,
      );
      assert(!again.missing.includes(one), `uploaded blob ${one} still reported missing`);
    },
  },
  {
    name: 'CacheEntriesTravelAsBlobs',
    async run(mk) {
      const p = mk();
      const b = mkCacheBundle(
        bytes('worker'),
        { '/a.js': bytes('asset a') },
        { 'b1/index.cache': bytes('prerendered index'), 'b1/about.cache': bytes('prerendered about') },
      );
      const res = await mustSync(p, identity('demo', 'git@github.com:x/demo.git'), b.manifest);
      assert(
        res.missing.length === b.content.size,
        `missing = ${res.missing.length} blobs, want all ${b.content.size} including the cache seed`,
      );
      for (const c of b.manifest.cache) {
        assert(
          hasDigest(res.missing, c.digest),
          `cache entry ${q(c.path)} (${c.digest}) was not reported missing: ${res.missing}`,
        );
      }
      // Everything but one cache entry: the deploy must still be waiting.
      const hold = b.manifest.cache[0]!.digest;
      const rest = res.missing.filter((d) => d !== hold);
      await putAll(p, res.app.id, rest, b);
      const st = await p.status(res.app.id, res.deployId);
      assert(
        !stateTerminal(st.state),
        `state = ${q(st.state)} with cache entry ${hold} still missing, want in progress`,
      );
      await putAll(p, res.app.id, [hold], b);
      await waitLive(p, res.app.id, res.deployId);
    },
  },
  {
    name: 'CacheEntryIdentifiesTheDeploy',
    async run(mk) {
      const p = mk();
      const worker = bytes('worker');
      const v1 = mkCacheBundle(worker, null, { 'b1/index.cache': bytes('prerendered v1') });
      const v2 = mkCacheBundle(worker, null, { 'b1/index.cache': bytes('prerendered v2') });
      assert(
        canonicalDigest(v1.manifest) !== canonicalDigest(v2.manifest),
        'changing a cache entry did not change the manifest canonical digest',
      );
      const asAsset: Manifest = {
        kind: MANIFEST_KIND_BUNDLE,
        worker: v1.manifest.worker,
        assets: v1.manifest.cache,
        cache: [],
      };
      assert(
        canonicalDigest(asAsset) !== canonicalDigest(v1.manifest),
        'the same blob as an asset and as a cache entry share a canonical digest',
      );
      const id = identity('demo', 'git@github.com:x/demo.git');
      const first = await pushToLive(p, id, v1);
      id.appId = first.app.id;
      const second = await mustSync(p, id, v2.manifest);
      assert(second.deployId !== first.deployId, 'a changed cache entry produced the same deploy id');
      assert(
        second.missing.length === 1 && second.missing[0] === v2.manifest.cache[0]!.digest,
        `missing = ${second.missing}, want only the changed cache entry ${v2.manifest.cache[0]!.digest}`,
      );
    },
  },
  {
    name: 'FingerprintAutoLink',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const remote = 'git@github.com:x/demo.git';
      const first = await mustSync(p, identity('demo', remote), b.manifest);
      // A fresh clone: no appId in config, same remote and slug.
      const again = await mustSync(p, identity('demo', remote), b.manifest);
      assert(
        again.resolution === Resolution.FingerprintLinked,
        `resolution = ${q(again.resolution)}, want fingerprint_linked`,
      );
      assert(again.app.id === first.app.id, `linked to ${q(again.app.id)}, want ${q(first.app.id)}`);
    },
  },
  {
    name: 'AmbiguousIdentity',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const remote = 'git@github.com:x/demo.git';
      await mustSync(p, identity('demo', remote), b.manifest);
      const dup = identity('demo', remote);
      dup.forceNew = true;
      await mustSync(p, dup, b.manifest);
      const de = await wantCode(
        () => p.sync({ identity: identity('demo', remote), manifest: b.manifest }),
        DeployCode.AmbiguousIdentity,
      );
      assert(de.candidates.length >= 2, `want >=2 candidates, got ${de.candidates}`);
    },
  },
  {
    name: 'ForceNewCreatesSecondApp',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const remote = 'git@github.com:x/demo.git';
      const first = await mustSync(p, identity('demo', remote), b.manifest);
      const dup = identity('demo', remote);
      dup.forceNew = true;
      const second = await mustSync(p, dup, b.manifest);
      assert(
        second.resolution === Resolution.Created && second.app.id !== first.app.id,
        `ForceNew reused app: ${JSON.stringify(second)}`,
      );
    },
  },
  {
    name: 'ClientRefDedupesCreate',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const id: Identity = {
        appId: '',
        slug: 'demo',
        framework: 'next',
        gitRemote: '',
        clientRef: 'nonce-1',
        forceNew: false,
      }; // no git remote
      const first = await mustSync(p, id, b.manifest);
      // Crash before persisting appId; the retried push carries the same clientRef.
      const again = await mustSync(p, id, b.manifest);
      assert(
        again.app.id === first.app.id,
        `clientRef retry created a second app: ${q(again.app.id)} vs ${q(first.app.id)}`,
      );
    },
  },
  {
    name: 'NoSuchApp',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const id = identity('demo', 'git@github.com:x/demo.git');
      id.appId = 'app_does_not_exist';
      await wantCode(() => p.sync({ identity: id, manifest: b.manifest }), DeployCode.NoSuchApp);
    },
  },
  {
    name: 'PreflightRejectsOversizeWorker',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      b.manifest.worker.size = MAX_WORKER_GZIP_BYTES + 1;
      await wantCode(
        () => p.sync({ identity: identity('demo', 'git@github.com:x/demo.git'), manifest: b.manifest }),
        DeployCode.PreflightRejected,
      );
    },
  },
  {
    name: 'DigestMismatchThenRecovery',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), { '/a.js': bytes('a') });
      const res = await mustSync(p, identity('demo', 'git@github.com:x/demo.git'), b.manifest);
      const d = b.manifest.worker.digest;
      await wantCode(
        () => p.putBlob(res.app.id, d, b.manifest.worker.size, bodyOf(bytes('corrupted'))),
        DeployCode.DigestMismatch,
      );
      // Correct bytes still succeed afterwards; the deploy is not wedged.
      await putAll(p, res.app.id, res.missing, b);
      const st = await p.status(res.app.id, res.deployId);
      assert(st.state === State.Live, `after recovery want live, got ${JSON.stringify(st)}`);
    },
  },
  {
    name: 'InvalidBlobRejected',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const res = await mustSync(p, identity('demo', 'git@github.com:x/demo.git'), b.manifest);
      const rogue = bytes('never declared');
      await wantCode(
        () => p.putBlob(res.app.id, digestBytes(rogue), rogue.length, bodyOf(rogue)),
        DeployCode.InvalidBlob,
      );
    },
  },
  {
    name: 'StatusUnknownDeployNotFound',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const res = await pushToLive(p, identity('demo', 'git@github.com:x/demo.git'), b);
      await wantCode(() => p.status(res.app.id, 'dep_never_existed'), DeployCode.NotFound);
    },
  },
  {
    name: 'RedeployUploadsOnlyChangedBlobs',
    async run(mk) {
      const p = mk();
      const worker = bytes('worker');
      const v1 = mkBundle(worker, { '/a.js': bytes('a'), '/b.css': bytes('b') });
      const id = identity('demo', 'git@github.com:x/demo.git');
      const res = await pushToLive(p, id, v1);
      const v2 = mkBundle(worker, { '/a.js': bytes('a'), '/b.css': bytes('b v2') });
      id.appId = res.app.id;
      const next = await mustSync(p, id, v2.manifest);
      assert(next.deployId !== res.deployId, 'changed manifest produced the same deploy id');
      const changed = digestBytes(bytes('b v2'));
      assert(
        next.missing.length === 1 && next.missing[0] === changed,
        `missing = ${next.missing}, want only the changed asset ${changed}`,
      );
      assert(next.app.url === res.app.url, `URL changed across deploys: ${q(next.app.url)} vs ${q(res.app.url)}`);
    },
  },
  {
    name: 'RevertRepushReactivates',
    async run(mk) {
      const p = mk();
      const worker = bytes('worker');
      const v1 = mkBundle(worker, { '/index.html': bytes('v1') });
      const v2 = mkBundle(worker, { '/index.html': bytes('v2') });
      const id = identity('demo', 'git@github.com:x/demo.git');
      const first = await pushToLive(p, id, v1);
      id.appId = first.app.id;
      const second = await pushToLive(p, id, v2);
      const third = await mustSync(p, id, v1.manifest);
      assert(third.deployId === first.deployId, `re-push of v1 derived ${q(third.deployId)}, want ${q(first.deployId)}`);
      assert(third.missing.length === 0, `missing = ${third.missing}, want none: the blobs never left`);
      assert(third.state === State.Live, `state = ${q(third.state)}, want live: reverted content must re-activate`);
      // The deploy v1 replaced is forgotten. If its row survived, the next
      // revert onto it would find a terminal "live" and skip re-activation.
      await wantCode(() => p.status(first.app.id, second.deployId), DeployCode.NotFound);
    },
  },
  {
    name: 'DeleteDryRunChangesNothing',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), { '/a.js': bytes('a') });
      const res = await pushToLive(p, identity('demo', 'git@github.com:x/demo.git'), b);
      const got = await p.delete({ appId: res.app.id, confirm: '' });
      assert(!got.deleted, 'a dry run reported the app deleted');
      assert(
        got.app.id === res.app.id && got.app.slug !== '' && got.app.url !== '',
        `dry run must name what it would destroy, got ${JSON.stringify(got.app)}`,
      );
      const st = await p.status(res.app.id, res.deployId);
      assert(st.state === State.Live, `dry run disturbed a live app: ${JSON.stringify(st)}`);
    },
  },
  {
    name: 'DeleteRejectsWrongName',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), null);
      const res = await pushToLive(p, identity('demo', 'git@github.com:x/demo.git'), b);
      await wantCode(
        () => p.delete({ appId: res.app.id, confirm: 'some-other-app' }),
        DeployCode.ConfirmationRequired,
      );
      const st = await p.status(res.app.id, res.deployId);
      assert(st.state === State.Live, `a rejected delete took the app down: ${JSON.stringify(st)}`);
    },
  },
  {
    name: 'DeleteDestroysTheApp',
    async run(mk) {
      const p = mk();
      const b = mkBundle(bytes('worker'), { '/a.js': bytes('a') });
      const id = identity('demo', 'git@github.com:x/demo.git');
      const res = await pushToLive(p, id, b);
      const got = await p.delete({ appId: res.app.id, confirm: res.app.slug });
      assert(got.deleted && got.app.id === res.app.id, `Delete reported ${JSON.stringify(got)}, want the app deleted`);
      // The app id is no longer addressable, by any verb.
      const byId = { ...id, appId: res.app.id };
      await wantCode(() => p.sync({ identity: byId, manifest: b.manifest }), DeployCode.NoSuchApp);
      await wantCode(() => p.delete({ appId: res.app.id, confirm: res.app.slug }), DeployCode.NoSuchApp);
      // The project is free again: same remote and slug, nothing to autolink onto.
      const again = await mustSync(p, identity('demo', 'git@github.com:x/demo.git'), b.manifest);
      assert(
        again.resolution === Resolution.Created,
        `resolution = ${q(again.resolution)}, want created after the old app was deleted`,
      );
      assert(
        again.app.id !== res.app.id && again.app.url !== res.app.url,
        `a deleted app identity was reissued: ${JSON.stringify(again.app)}`,
      );
      assert(
        again.missing.length === b.content.size,
        `missing = ${again.missing.length} blobs, want all ${b.content.size}: deleted content survived`,
      );
    },
  },
];
