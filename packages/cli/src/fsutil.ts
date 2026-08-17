import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
export function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
export function writeAtomic(file: string, body: string, mode?: number): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode });
  const tmp = path.join(dir, `.280-${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, body, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
}
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n', mode);
}
