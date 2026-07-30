// Shared bundle primitives: the preflight error, filesystem predicates, and
// walkAssets (the asset shaping both frameworks share). Spec: bundle.go, normative.

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

export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Orders by UTF-8 bytes, matching Go's string < (what os.ReadDir sorts by), so the
// asset list order is deterministic and matches the Go CLI.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// Yields every file under dir, pre-order and lexically sorted by basename within
// each directory, exactly as Go's filepath.WalkDir does. Each yield carries the
// absolute path and the "/"-joined path relative to dir.
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

// Content-addresses every file under dir into content, returning one BlobInfo per
// file keyed by its serving URL path ("/" + relative path). Shared because both
// frameworks treat their tree as the site root.
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
