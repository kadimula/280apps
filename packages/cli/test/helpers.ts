// Shared test scaffolding: an in-memory Streams capture, a minimal bundle, an
// AuthClient double, and a runCli harness that drives the real command surface
// (app.run) with injected deps so no test touches stdio, the network, or a
// subprocess. Integration tests pass W1's real Fake as the port.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestBytes, type Manifest, type Port } from '@280/contracts';
import { run, type Deps, type Env } from '../src/app.js';
import { CliError } from '../src/output.js';
import type { AuthClient } from '../src/login.js';
import type { Bundle } from '../src/push.js';

export interface Capture {
  streams: { out(s: string): void; err(s: string): void };
  out(): string;
  err(): string;
}

export function capture(): Capture {
  let out = '';
  let err = '';
  return {
    streams: { out: (s) => (out += s), err: (s) => (err += s) },
    out: () => out,
    err: () => err,
  };
}

// tmpProject makes a throwaway static project (an index.html) and returns its
// root. Registered for cleanup by the caller via rmProject.
export function tmpProject(files: Record<string, string> = { 'index.html': '<h1>hi</h1>' }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '280-test-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

export function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), '280-home-'));
}

// testBundle is a minimal, self-consistent bundle: one worker blob and one
// asset, digests derived the same way the real bundler and the platform do, so
// W1's Fake accepts it and reports the right missing set.
export function testBundle(): Bundle {
  const worker = new TextEncoder().encode('export default { fetch() { return new Response("hi"); } };');
  const wd = digestBytes(worker);
  const asset = new TextEncoder().encode('<h1>hi</h1>');
  const ad = digestBytes(asset);
  const manifest: Manifest = {
    kind: 'bundle',
    worker: { path: '', digest: wd, size: worker.length },
    assets: [{ path: '/index.html', digest: ad, size: asset.length }],
    cache: [],
  };
  const content = new Map<string, Uint8Array>([
    [wd, worker],
    [ad, asset],
  ]);
  return { manifest, content, notes: [] };
}

export interface StubAuthOptions {
  api: string;
  token?: string; // when set, redeem returns it; otherwise redeem stays pending
  deviceCode?: string;
  userCode?: string;
  onStart?: () => void;
  onRedeem?: () => void;
}

// stubAuth is an AuthClient double. redeem returns a token when configured, else
// throws the flow's authorization_pending answer (what an unconfirmed login
// returns).
export function stubAuth(opts: StubAuthOptions): AuthClient {
  return {
    async start() {
      opts.onStart?.();
      return {
        deviceCode: opts.deviceCode ?? 'dev-code-1',
        userCode: opts.userCode ?? 'ABCD-EFGH',
        verificationUri: opts.api + '/activate',
        expiresIn: 600,
        interval: 5,
      };
    },
    async redeem() {
      opts.onRedeem?.();
      if (opts.token) return opts.token;
      throw new CliError('authorization_pending', 'authorization pending', 'confirm the code');
    },
  };
}

export interface RunOptions {
  root: string;
  binPath?: string;
  port?: Port; // shared across commands in one test (mirrors one account)
  bundle?: Bundle;
  auth?: AuthClient;
  gitRemote?: string;
  now?: number;
  deps?: Partial<Deps>;
}

export function makeDeps(o: RunOptions): Deps {
  const port = o.port;
  return {
    buildBundle: o.deps?.buildBundle ?? (async () => o.bundle ?? testBundle()),
    openPort: o.deps?.openPort ?? (async () => port ?? unusedPort()),
    authClient: o.deps?.authClient ?? (() => o.auth ?? unusedAuth()),
    gitRemote: o.deps?.gitRemote ?? (() => o.gitRemote ?? ''),
    now: o.deps?.now ?? (() => o.now ?? 1_000_000),
  };
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export async function runCli(args: string[], o: RunOptions): Promise<RunResult> {
  const cap = capture();
  const env: Env = {
    args,
    root: o.root,
    streams: cap.streams,
    binPath: o.binPath ?? '/usr/local/bin/280',
  };
  const code = await run(env, makeDeps(o));
  return { code, out: cap.out(), err: cap.err() };
}

function unusedPort(): Port {
  throw new Error('test did not provide a port but the command needed one');
}
// Constructing an auth client is always harmless (commands do it eagerly even
// when already logged in); only start/redeem need a real one, so the stub throws
// there rather than on construction.
function unusedAuth(): AuthClient {
  const boom = async (): Promise<never> => {
    throw new Error('test did not provide an auth client but the command needed one');
  };
  return { start: boom, redeem: boom };
}

// parseToon is a tiny TOON reader for assertions: it maps top-level `key: value`
// lines to strings. Enough to assert error `{code, fix}` and result fields
// without pulling the decoder's full surface into every test.
export function parseToon(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.trim().split('\n')) {
    const m = /^([A-Za-z0-9_]+):\s?(.*)$/.exec(line);
    if (m) out[m[1]!] = unquote(m[2]!);
  }
  return out;
}

function unquote(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return v;
}
