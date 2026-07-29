// jsonfile is the safe read-modify-write primitive every agent-config merge is
// built on. The named risk for `280 setup` is corrupting a config file
// (settings.json etc.), so the contract here is strict: parse the existing file
// as-is, hand the caller a mutable object, and write it back atomically (temp
// file + rename) with a trailing newline. A malformed existing file is a hard
// error, never a silent overwrite.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// readObject loads a JSON object from p. A missing file yields {} (the caller is
// creating it); a present but non-object or malformed file throws so a merge
// never clobbers content it failed to understand.
export function readObject(p: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to modify ${p}: not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`refusing to modify ${p}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// writeObject serializes obj as pretty JSON and replaces p atomically, creating
// parent directories as needed. The rename means a crash mid-write can never
// leave a truncated config.
export function writeObject(p: string, obj: unknown): void {
  writeAtomic(p, JSON.stringify(obj, null, 2) + '\n');
}

// writeAtomic writes body to p via a sibling temp file and rename.
export function writeAtomic(p: string, body: string): void {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.280-setup-${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; the original error is what matters
    }
    throw e;
  }
}
