// Independent TS reference derivations for the platform/cli-internal formulas the
// golden vectors freeze, proving the Go<->TS math agrees against vectors.json.
// Every function is line-cited to its normative Go spec.

import { createHash } from 'node:crypto';
import { canonicalDigest, type Manifest } from '../src/types.js';

function sha256hex(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

// deploysvc.go:586.
export function deriveDeployId(appId: string, m: Manifest): string {
  return 'dep_' + sha256hex(appId + ':' + canonicalDigest(m)).slice(0, 16);
}

// deploysvc.go:592.
export function fingerprint(gitRemote: string, slug: string): string {
  return sha256hex('fp:' + gitRemote + ':' + slug);
}

// deploysvc.go:601. seed is the hex-string digest; seed[i] is an ASCII hex char.
const base36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function urlToken(appId: string): string {
  const seed = sha256hex('token:' + appId);
  let tok = '';
  for (let i = 0; i < 10; i++) {
    tok += base36[seed.charCodeAt(i) % base36.length];
  }
  return tok;
}

// deploysvc.go:614.
function trimDashes(s: string): string {
  return s.replace(/^-+/, '').replace(/-+$/, '');
}
export function sanitizeSlug(raw: string): string {
  let s = trimDashes(raw.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  if (s.length > 40) s = trimDashes(s.slice(0, 40));
  if (s === '') s = 'app';
  return s;
}

// api.go normalizeUserCode / displayUserCode.
export function normalizeUserCode(s: string): string {
  return s.trim().toUpperCase().replaceAll('-', '');
}
export function displayUserCode(code: string): string {
  return code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
}

// api.go randomUserCode alphabet mapping.
export const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';
export function userCodeChar(byte: number): string {
  return USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]!;
}
