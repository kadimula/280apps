// Shared test scaffolding: in-memory Streams capture, a minimal bundle, an
// AuthClient double, and a runCli harness that drives app.run with injected deps.

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

// testBundle is a minimal, self-consistent container context: a Dockerfile and
// one source file, digests derived the same way the real bundler and the platform
// do, so the Fake accepts it and reports the right missing set.
export function testBundle(): Bundle {
  const dockerfile = new TextEncoder().encode('FROM node:20\nCMD ["node","server.js"]\n');
  const dd = digestBytes(dockerfile);
  const src = new TextEncoder().encode('console.log("hi")');
  const sd = digestBytes(src);
  const manifest: Manifest = {
    kind: 'container',
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [
      { path: 'Dockerfile', digest: dd, size: dockerfile.length },
      { path: 'server.js', digest: sd, size: src.length },
    ],
  };
  const content = new Map<string, Uint8Array>([
    [dd, dockerfile],
    [sd, src],
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

// AuthClient double: redeem returns a token when configured, else throws the
// authorization_pending answer an unconfirmed login returns.
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
// Constructing an auth client is harmless (commands do it eagerly even when
// logged in); only start/redeem need a real one, so the stub throws there.
function unusedAuth(): AuthClient {
  const boom = async (): Promise<never> => {
    throw new Error('test did not provide an auth client but the command needed one');
  };
  return { start: boom, redeem: boom };
}

// Tiny TOON reader for assertions: maps top-level `key: value` lines to strings,
// enough for error `{code, fix}` and result fields without the full decoder.
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
