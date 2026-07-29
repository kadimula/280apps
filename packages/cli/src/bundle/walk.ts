// Shared bundle primitives: the preflight error the whole package raises, small
// filesystem predicates, and walkAssets — the one asset shaping both frameworks
// share. Spec: cli/internal/bundle/bundle.go (walkAssets, fileExists). Go is
// normative.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DeployCode, digestBytes, type BlobInfo, type Digest } from '@280/contracts';

// PreflightError is every failure this package raises: a preflight rejection the
// agent can act on verbatim. It mirrors the Go output.Fail shape (code, message,
// fix) so the CLI's output layer (W2) renders it exactly as it renders any other
// deploy error. All bundle failures are CodePreflightRejected (bundle.go).
export class PreflightError extends Error {
  readonly code: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly candidates: readonly string[];

  constructor(
    message: string,
    fix: string,
    code: string = DeployCode.PreflightRejected,
  ) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
    this.fix = fix;
    this.retryable = false;
    this.candidates = [];
  }
}

// fail raises a preflight rejection. Throwing (vs Go's returned error) lets the
// deep call chains here propagate a failure without threading it through every
// return.
export function fail(
  message: string,
  fix: string,
  code: string = DeployCode.PreflightRejected,
): never {
  throw new PreflightError(message, fix, code);
}

// fileExists reports whether p is an existing regular file (mirrors bundle.go
// fileExists: a directory does not count).
export function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// dirExists reports whether p is an existing directory.
export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// byteCompare orders two strings by their UTF-8 bytes, matching Go's string <
// (which os.ReadDir uses to sort directory entries). WalkDir visits entries in
// this order, so the asset list order is deterministic and matches the Go CLI.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// walkFiles yields every file under dir, pre-order and lexically sorted by
// basename within each directory, exactly as Go's filepath.WalkDir does. Each
// yield carries the absolute path and the "/"-joined path relative to dir.
export function* walkFiles(
  dir: string,
): Generator<{ abs: string; rel: string }> {
  yield* walkFrom(dir, '');
}

function* walkFrom(
  dir: string,
  prefix: string,
): Generator<{ abs: string; rel: string }> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    byteCompare(a.name, b.name),
  );
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = prefix === '' ? e.name : prefix + '/' + e.name;
    if (e.isDirectory()) {
      yield* walkFrom(abs, rel);
    } else {
      yield { abs, rel };
    }
  }
}

// walkAssets content-addresses every file under dir into content, returning one
// BlobInfo per file keyed by its serving URL path (bundle.go walkAssets). Both
// frameworks shape asset paths the same way — a static build dir and
// .open-next/assets are both "this tree is the site root" — so it lives here
// once. The path is "/" + the cleaned slash-joined relative path.
export function walkAssets(
  dir: string,
  content: Map<Digest, Uint8Array>,
): BlobInfo[] {
  const out: BlobInfo[] = [];
  for (const { abs, rel } of walkFiles(dir)) {
    const data = readFileSync(abs);
    const dig = digestBytes(data);
    content.set(dig, data);
    out.push({ path: '/' + rel, digest: dig, size: data.length });
  }
  return out;
}
