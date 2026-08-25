import { createHash, timingSafeEqual } from 'node:crypto';

// Opaque tokens (sessions, device codes, machine tokens, OAuth state) are stored
// only as this hash, so comparing an incoming token means hashing it and matching
// the stored digest.
export function hashToken(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
