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
  MANIFEST_KIND_CONTAINER,
  MAX_BUILD_CONTEXT_BYTES,
  DeployCode,
  type BlobInfo,
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

// ---- context + identity helpers ----

interface Bundle {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
}

function bytes(s: string): Uint8Array {
  return Buffer.from(s, 'utf8');
}

// A constant Dockerfile so every context is buildable and its blob is shared
// across deploys (a redeploy re-uploads only the files that actually changed).
const DOCKERFILE = bytes('FROM node:20-bookworm-slim\nCMD ["node","server.js"]\n');

// mkContext builds a container manifest from a flat set of context files. It
// always includes a Dockerfile, so the context passes preflight and names a
// valid build recipe; callers add the source files that vary per case.
function mkContext(files: Record<string, Uint8Array>): Bundle {
  const content = new Map<Digest, Uint8Array>();
  const list: BlobInfo[] = [];
  const add = (path: string, data: Uint8Array): void => {
    const d = digestBytes(data);
    content.set(d, data);
    list.push({ path, digest: d, size: data.length });
  };
  add('Dockerfile', DOCKERFILE);
  for (const [path, data] of Object.entries(files)) add(path, data);
  return {
    manifest: {
      kind: MANIFEST_KIND_CONTAINER,
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: list,
      egress: { allowedHosts: [], credentials: [] },
      access: 'invited',
      roles: [],
      routes: [],
      secrets: [],
      config: [],
      integrations: [],
    },
    content,
  };
}

// fileDigest returns a named context file's blob info, for cases that re-put or
// corrupt a specific file.
function fileDigest(m: Manifest, path: string): BlobInfo {
  const f = m.files.find((x) => x.path === path);
  assert(f !== undefined, `context has no file ${q(path)}`);
  return f;
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

// URL scheme: <slug>-<10 base36>.<domain>.
const urlRe = /^https:\/\/[a-z0-9-]+-[a-z0-9]{10}\.[a-z0-9.-]+$/;

// ---- the 20 cases, in the order conformance.go registers them ----

export const cases: ConformanceCase[] = [
  {
    name: 'CreateOnFirstSync',
    async run(mk) {
      const p = mk();
      const b = mkContext({ 'public/a.js': bytes('a') });
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
      const b = mkContext({ 'public/a.js': bytes('a') });
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
      const b = mkContext({ 'public/a.js': bytes('a'), 'public/b.css': bytes('b') });
      const res = await pushToLive(p, identity('demo', 'git@github.com:x/demo.git'), b);
      // Re-put after live: idempotent no-op.
      const f = fileDigest(b.manifest, 'Dockerfile');
      await p.putBlob(res.app.id, f.digest, f.size, bodyOf(b.content.get(f.digest)!));
      const st = await p.status(res.app.id, res.deployId);
      assert(st.state === State.Live && st.url !== '', `want live with URL, got ${JSON.stringify(st)}`);
    },
  },
  {
    name: 'MissingShrinksAsBlobsLand',
    async run(mk) {
      const p = mk();
      const b = mkContext({ 'public/a.js': bytes('a'), 'public/b.css': bytes('b') });
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
    name: 'PartialContextStaysInProgress',
    async run(mk) {
      const p = mk();
      const b = mkContext({
        'public/a.js': bytes('asset a'),
        'app/index.js': bytes('page index'),
        'app/about.js': bytes('page about'),
      });
      const res = await mustSync(p, identity('demo', 'git@github.com:x/demo.git'), b.manifest);
      assert(
        res.missing.length === b.content.size,
        `missing = ${res.missing.length} blobs, want all ${b.content.size} context files`,
      );
      // Everything but one file: the deploy must still be waiting.
      const hold = res.missing[0]!;
      const rest = res.missing.filter((d) => d !== hold);
      await putAll(p, res.app.id, rest, b);
      const st = await p.status(res.app.id, res.deployId);
      assert(
        !stateTerminal(st.state),
        `state = ${q(st.state)} with file ${hold} still missing, want in progress`,
      );
      await putAll(p, res.app.id, [hold], b);
      await waitLive(p, res.app.id, res.deployId);
    },
  },
  {
    name: 'FileContentIdentifiesTheDeploy',
    async run(mk) {
      const p = mk();
      const v1 = mkContext({ 'app/page.js': bytes('page v1') });
      const v2 = mkContext({ 'app/page.js': bytes('page v2') });
      assert(
        canonicalDigest(v1.manifest) !== canonicalDigest(v2.manifest),
        'changing a file did not change the manifest canonical digest',
      );
      // The same bytes at a different path are a different manifest: the path is
      // part of the build context, so it is part of the digest.
      const moved = mkContext({ 'app/moved.js': bytes('page v1') });
      assert(
        canonicalDigest(moved.manifest) !== canonicalDigest(v1.manifest),
        'the same bytes at a different context path share a canonical digest',
      );
      const id = identity('demo', 'git@github.com:x/demo.git');
      const first = await pushToLive(p, id, v1);
      id.appId = first.app.id;
      const second = await mustSync(p, id, v2.manifest);
      assert(second.deployId !== first.deployId, 'a changed file produced the same deploy id');
      const changed = fileDigest(v2.manifest, 'app/page.js').digest;
      assert(
        second.missing.length === 1 && second.missing[0] === changed,
        `missing = ${second.missing}, want only the changed file ${changed}`,
      );
    },
  },
  {
    name: 'FingerprintAutoLink',
    async run(mk) {
      const p = mk();
      const b = mkContext({});
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
      const b = mkContext({});
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
      const b = mkContext({});
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
      const b = mkContext({});
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
      const b = mkContext({});
      const id = identity('demo', 'git@github.com:x/demo.git');
      id.appId = 'app_does_not_exist';
      await wantCode(() => p.sync({ identity: id, manifest: b.manifest }), DeployCode.NoSuchApp);
    },
  },
  {
    name: 'PreflightRejectsOversizeContext',
    async run(mk) {
      const p = mk();
      const b = mkContext({});
      // Declare the Dockerfile bigger than the whole context budget: raw over the
      // limit can never fit, so preflight rejects before any state changes.
      fileDigest(b.manifest, 'Dockerfile').size = MAX_BUILD_CONTEXT_BYTES + 1;
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
      const b = mkContext({ 'public/a.js': bytes('a') });
      const res = await mustSync(p, identity('demo', 'git@github.com:x/demo.git'), b.manifest);
      const f = fileDigest(b.manifest, 'Dockerfile');
      await wantCode(
        () => p.putBlob(res.app.id, f.digest, f.size, bodyOf(bytes('corrupted'))),
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
      const b = mkContext({});
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
      const b = mkContext({});
      const res = await pushToLive(p, identity('demo', 'git@github.com:x/demo.git'), b);
      await wantCode(() => p.status(res.app.id, 'dep_never_existed'), DeployCode.NotFound);
    },
  },
  {
    name: 'RedeployUploadsOnlyChangedBlobs',
    async run(mk) {
      const p = mk();
      const v1 = mkContext({ 'public/a.js': bytes('a'), 'public/b.css': bytes('b') });
      const id = identity('demo', 'git@github.com:x/demo.git');
      const res = await pushToLive(p, id, v1);
      const v2 = mkContext({ 'public/a.js': bytes('a'), 'public/b.css': bytes('b v2') });
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
      const v1 = mkContext({ 'public/index.html': bytes('v1') });
      const v2 = mkContext({ 'public/index.html': bytes('v2') });
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
      const b = mkContext({ 'public/a.js': bytes('a') });
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
      const b = mkContext({});
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
      const b = mkContext({ 'public/a.js': bytes('a') });
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
  {
    name: 'AppStatusReturnsLiveDeploy',
    async run(mk) {
      const p = mk();
      const b = mkContext({ 'public/a.js': bytes('a') });
      const res = await pushToLive(p, identity('demo', 'git@github.com:x/demo.git'), b);
      const st = await p.appStatus(res.app.id);
      assert(st.state === State.Live, `want live, got ${q(st.state)}`);
      assert(st.url !== '', 'live app must have a URL');
    },
  },
  {
    name: 'AppStatusNoSuchApp',
    async run(mk) {
      const p = mk();
      await wantCode(() => p.appStatus('app_does_not_exist'), DeployCode.NotFound);
    },
  },
];
