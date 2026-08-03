// Shared bundle primitives: the preflight error the whole package raises, small
// filesystem predicates, and walkContext — the build-context shaping both
// frameworks share.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DeployCode, digestBytes, type BlobInfo, type Digest } from '@280/contracts';

// Every failure this package raises: a preflight rejection the agent can act on
// verbatim, mirroring the Go output.Fail shape (code, message, fix) so the CLI's
// output layer renders it like any other deploy error.
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

// Throwing (vs Go's returned error) lets deep call chains propagate a failure
// without threading it through every return.
export function fail(
  message: string,
  fix: string,
  code: string = DeployCode.PreflightRejected,
): never {
  throw new PreflightError(message, fix, code);
}

// Whether p is an existing regular file: a directory does not count.
export function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Orders by UTF-8 bytes, matching Go's string < (what os.ReadDir sorts by), so the
// asset list order is deterministic and matches the Go CLI.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// walkFiles yields every file under dir, pre-order and lexically sorted by
// basename within each directory, exactly as Go's filepath.WalkDir does. Each
// yield carries the absolute path and the "/"-joined path relative to dir. An
// optional skip(rel, isDir) prunes a subtree or a file before it is visited.
function* walkFiles(
  dir: string,
  skip?: (rel: string, isDir: boolean) => boolean,
): Generator<{ abs: string; rel: string }> {
  yield* walkFrom(dir, '', skip);
}

function* walkFrom(
  dir: string,
  prefix: string,
  skip?: (rel: string, isDir: boolean) => boolean,
): Generator<{ abs: string; rel: string }> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    byteCompare(a.name, b.name),
  );
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = prefix === '' ? e.name : prefix + '/' + e.name;
    const isDir = e.isDirectory();
    if (skip?.(rel, isDir)) continue;
    if (isDir) {
      yield* walkFrom(abs, rel, skip);
    } else {
      yield { abs, rel };
    }
  }
}

// walkContext content-addresses every file under dir into content, returning one
// BlobInfo per file keyed by its context-relative path (no leading slash), under
// an optional path prefix so a subtree can be placed elsewhere in the build
// context. skip(rel) drops a whole subtree (a directory) or a single file before
// it is read — used to keep node_modules, VCS metadata, and secrets out of the
// context.
export function walkContext(
  dir: string,
  content: Map<Digest, Uint8Array>,
  opts: { prefix?: string; skip?: (rel: string, isDir: boolean) => boolean } = {},
): BlobInfo[] {
  const prefix = opts.prefix ? opts.prefix.replace(/\/+$/, '') + '/' : '';
  const out: BlobInfo[] = [];
  for (const { abs, rel } of walkFiles(dir, opts.skip)) {
    const data = readFileSync(abs);
    const dig = digestBytes(data);
    content.set(dig, data);
    out.push({ path: prefix + rel, digest: dig, size: data.length });
  }
  return out;
}
