// Test harness: builds a Platform on the real MemoryRuntime and filesystem blob
// store, with the real Postgres store when TEST_DATABASE_URL is set and an
// in-memory store double otherwise. In-process tests use the Service (Port)
// directly; transport tests go through the router via app.request. Mirrors
// platform/conformance_test.go's newPlatform.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  DeployErr,
  digestBytes,
  MANIFEST_KIND_CONTAINER,
  type Digest,
  type Manifest,
  type SyncRequest,
  type SyncResult,
  type DeployStatus,
  type DeleteResult,
} from '@280/contracts';
import { Platform, type Service } from '../../src/deploysvc.js';
import { InProcessActivator } from '../../src/activator.js';
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

// builds an empty platform: a fresh Postgres schema (or store double), a fresh
// blob directory, and a fresh in-memory runtime per call.
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
  // tests expect a deploy live the moment its last blob lands, so the in-process
  // activator runs activation inline (the single-isolate equivalent of
  // production's AppActivator Durable Object).
  const activator = new InProcessActivator({ store, blobs, runtime });
  const platform = new Platform({
    store,
    blobs,
    activator,
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

// returns a Service scoped to a user, creating the user first. The email is derived
// from the id so distinct ids never collide on the unique users_by_email index.
export async function portFor(h: Harness, userId = 'usr_test'): Promise<Service> {
  await ensureUser(h, userId);
  return h.platform.for(userId);
}

// seeds a user and binds a CLI bearer token to it, mirroring api.ts hashToken
// (sha256 hex) so authorize() resolves the token to the user.
export async function seedToken(h: Harness, userId: string, token: string): Promise<void> {
  await ensureUser(h, userId);
  await h.store.addToken(userId, createHash('sha256').update(token, 'utf8').digest('hex'));
}

async function ensureUser(h: Harness, userId: string): Promise<void> {
  if ((await h.store.userById(userId)) === null) {
    await h.store.createUser({ id: userId, email: `${userId}@test`, name: '', image: '' });
  }
}

// The test-facing surface: per-request config a case wants on the deps container,
// plus an optional shared harness and access logger. Server takes a buildDeps
// closure, not these fields; testDeps wraps them.
export interface TestServerOpts {
  harness?: Harness;
  auth?: Auth;
  verificationUri?: string;
  minCliVersion?: string;
  logger?: Logger;
}

// the request-scoped deps a test drives the router with. The harness store is
// shared and torn down once, so there is no per-request close() (production's
// pg-client close has no analogue here).
export function testDeps(harness: Harness, opts: Omit<TestServerOpts, 'harness' | 'logger'> = {}): RequestDeps {
  return {
    platform: harness.platform,
    auth: opts.auth,
    verificationUri: opts.verificationUri ?? '',
    minCliVersion: opts.minCliVersion ?? '',
    appDomain: '280apps.run',
    viewAsOrigin: 'https://auth.280apps.run',
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

// testManifest is a well-formed minimal container context whose only file is the
// Dockerfile. The returned worker/digest name that one blob, so callers upload it
// as the deploy's single content.
export function testManifest(content = 'FROM scratch\n'): { manifest: Manifest; worker: Uint8Array; digest: Digest } {
  const worker = new TextEncoder().encode(content);
  const digest = digestBytes(worker);
  const manifest: Manifest = {
    kind: MANIFEST_KIND_CONTAINER,
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest, size: worker.byteLength }],
  };
  return { manifest, worker, digest };
}

// HTTP client over the hono app (mirrors deployhttp).
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

// returns the decoded success body or throws the seam's error, the way a real
// client does.
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

// records structured log records for assertions (the JSON access log in Go's
// observe_test).
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

export function requests(records: Captured[]): Captured[] {
  return records.filter((r) => r.msg === 'request');
}

export function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// wraps bytes as a single-chunk BlobBody for in-process putBlob calls (iterating
// a Uint8Array directly would yield numbers, not chunks).
export function bodyOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}

export { DeployErr };
