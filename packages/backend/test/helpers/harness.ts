// Test harness: builds a Platform on the real runtime (W6 MemoryRuntime) and the
// real filesystem blob store (W4), with the real Postgres store when
// TEST_DATABASE_URL is set and an in-memory store double otherwise. In-process
// tests use the Service (Port) directly; transport tests go through the router
// via app.request. Mirrors platform/conformance_test.go's newPlatform.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  DeployErr,
  digestBytes,
  MANIFEST_KIND_BUNDLE,
  type Digest,
  type Manifest,
  type SyncRequest,
  type SyncResult,
  type DeployStatus,
  type DeleteResult,
} from '@280/contracts';
import { Platform, type Service } from '../../src/deploysvc.js';
import { Server } from '../../src/api.js';
import type { Auth } from '../../src/authsvc.js';
import type { RequestDeps } from '../../src/config.js';
import type { Logger, HonoEnv } from '../../src/observe.js';
import { open as openBlobStore } from '../../src/blobstore/index.js';
import { MemoryRuntime } from '../../src/runtime/index.js';
import type { Store } from '../../src/seams.js';
import { MemoryStore } from './memory-store.js';
import { hasDatabase, newStore } from '../pg.js';

export interface Harness {
  platform: Platform;
  store: Store;
  runtime: MemoryRuntime;
  cleanup: () => Promise<void>;
}

// newPlatform builds an empty platform. Each call is a fresh account's worth of
// infrastructure: a fresh Postgres schema (or store double), a fresh blob
// directory, and a fresh in-memory runtime.
export async function newPlatform(opts: { appDomain?: string; hostSuffix?: string } = {}): Promise<Harness> {
  const cleanups: Array<() => Promise<void> | void> = [];

  let store: Store;
  if (hasDatabase()) {
    const s = await newStore();
    store = s.store;
    cleanups.push(s.cleanup);
  } else {
    store = new MemoryStore();
  }

  const dir = mkdtempSync(join(tmpdir(), '280-blobs-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const blobs = await openBlobStore(dir);

  const runtime = new MemoryRuntime();
  const platform = new Platform({
    store,
    blobs,
    runtime,
    appDomain: opts.appDomain ?? '280apps.run',
    hostSuffix: opts.hostSuffix ?? '',
  });

  return {
    platform,
    store,
    runtime,
    cleanup: async () => {
      for (const c of cleanups.reverse()) await c();
    },
  };
}

// portFor returns a Service scoped to an account, creating the account first.
export async function portFor(h: Harness, accountId = 'acct_test'): Promise<Service> {
  await h.store.createAccount({ id: accountId, subject: '' });
  return h.platform.for(accountId);
}

// TestServerOpts is the test-facing surface: the per-request config a case wants
// on the deps container, plus an optional shared harness and access logger. The
// new Server takes a buildDeps closure, not these fields; testDeps wraps them.
export interface TestServerOpts {
  harness?: Harness;
  auth?: Auth;
  openSignup?: boolean;
  verificationUri?: string;
  minCliVersion?: string;
  logger?: Logger;
}

// testDeps returns the request-scoped deps a test drives the router with. The
// harness store is shared across requests and torn down once, so there is no
// per-request close(): the production close (ending the pg client) has no
// analogue here.
export function testDeps(harness: Harness, opts: Omit<TestServerOpts, 'harness' | 'logger'> = {}): RequestDeps {
  return {
    platform: harness.platform,
    auth: opts.auth,
    openSignup: opts.openSignup ?? false,
    verificationUri: opts.verificationUri ?? '',
    minCliVersion: opts.minCliVersion ?? '',
  };
}

export async function newServer(
  cfg: TestServerOpts = {},
): Promise<{ server: Server; app: Hono<HonoEnv>; harness: Harness }> {
  const harness = cfg.harness ?? (await newPlatform());
  const deps = testDeps(harness, cfg);
  const server = new Server({ buildDeps: () => deps, logger: cfg.logger });
  return { server, app: server.handler(), harness };
}

// testManifest is a well-formed minimal bundle whose only blob is the worker.
export function testManifest(content = 'worker'): { manifest: Manifest; worker: Uint8Array; digest: Digest } {
  const worker = new TextEncoder().encode(content);
  const digest = digestBytes(worker);
  const manifest: Manifest = {
    kind: MANIFEST_KIND_BUNDLE,
    worker: { path: '', digest, size: worker.byteLength },
    assets: [],
    cache: [],
  };
  return { manifest, worker, digest };
}

// ---- HTTP client over the hono app (mirrors deployhttp) ----

export class HttpClient {
  constructor(
    private readonly app: Hono<HonoEnv>,
    private readonly token: string,
  ) {}

  private auth(): Record<string, string> {
    return { Authorization: 'Bearer ' + this.token };
  }

  async sync(req: SyncRequest): Promise<SyncResult> {
    const res = await this.app.request('/v1/sync', {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return (await parse(res)) as SyncResult;
  }

  async putBlob(appId: string, digest: Digest, body: Uint8Array): Promise<void> {
    const res = await this.app.request(`/v1/apps/${appId}/blobs/${digest}`, {
      method: 'PUT',
      headers: { ...this.auth(), 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (res.status !== 204) await parse(res); // throws the seam error
  }

  async status(appId: string, deployId: string): Promise<DeployStatus> {
    const res = await this.app.request(`/v1/apps/${appId}/deploys/${deployId}`, {
      method: 'GET',
      headers: this.auth(),
    });
    return (await parse(res)) as DeployStatus;
  }

  async delete(appId: string, confirm = ''): Promise<DeleteResult> {
    const res = await this.app.request(`/v1/apps/${appId}/delete`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, confirm }),
    });
    return (await parse(res)) as DeleteResult;
  }
}

// parse returns the decoded success body or throws the seam's error, the way a
// real client does: parse the body, fall back to nothing.
async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  const body = text === '' ? {} : JSON.parse(text);
  if (res.status >= 200 && res.status < 300) return body;
  const e = body as { code?: string; message?: string; fix?: string; retryable?: boolean; candidates?: string[] };
  throw new DeployErr({
    code: e.code ?? 'unavailable',
    message: e.message ?? '',
    fix: e.fix,
    retryable: e.retryable,
    candidates: e.candidates,
  });
}

// capturingLogger records structured records for assertions (the JSON access log
// in Go's observe_test).
export interface Captured {
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
  attrs: Record<string, unknown>;
}

export function capturingLogger(): { logger: Logger; records: Captured[] } {
  const records: Captured[] = [];
  const push = (level: Captured['level']) => (msg: string, attrs?: Record<string, unknown>) =>
    void records.push({ level, msg, attrs: attrs ?? {} });
  return {
    records,
    logger: { info: push('INFO'), warn: push('WARN'), error: push('ERROR') },
  };
}

// requests keeps only the access lines.
export function requests(records: Captured[]): Captured[] {
  return records.filter((r) => r.msg === 'request');
}

export function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// bodyOf wraps bytes as a single-chunk BlobBody for in-process putBlob calls
// (iterating a Uint8Array directly would yield numbers, not chunks).
export function bodyOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}

export { DeployErr };
