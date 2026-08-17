import { readOptional, writeAtomic as writeFileAtomic } from '../fsutil.js';
export function readObject(p: string): Record<string, unknown> {
  const raw = readOptional(p);
  if (raw === undefined || raw.trim() === '') return {};
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
export function writeObject(p: string, obj: unknown): void {
  writeAtomic(p, JSON.stringify(obj, null, 2) + '\n');
}
export const writeAtomic = writeFileAtomic;
