import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DeployCode, digestBytes, type BlobInfo, type Digest } from '@280/contracts';
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
export function fail(
  message: string,
  fix: string,
  code: string = DeployCode.PreflightRejected,
): never {
  throw new PreflightError(message, fix, code);
}
export function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
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
