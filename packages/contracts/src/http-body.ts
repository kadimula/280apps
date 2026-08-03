// Internal helpers shared by the HTTP adapters (deploy/http, auth/http): parse an
// error body, read a bounded body, and describe a thrown error. Not a public
// subpath: imported only by the sibling adapters, never re-exported from index.

import { errorSchema, type DeployError } from './errors.js';

// A non-JSON or non-error body yields undefined; the loose schema fills omitempty fields.
export function tryParseError(raw: string): DeployError | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const res = errorSchema.safeParse(obj);
  return res.success ? res.data : undefined;
}

// Reads the response body, bounded to 64 KiB.
export async function readBodyText(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '');
  return text.length > 64 << 10 ? text.slice(0, 64 << 10) : text;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
