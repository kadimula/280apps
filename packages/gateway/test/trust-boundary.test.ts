// The tenant Worker trust boundary: the app-Worker middleware and every local module it
// pulls in must hold NO signing key, DB, or backend. If any did, the per-app Worker
// bundle would carry the private identity key or a Postgres connection, collapsing the
// A2 topology (mint centrally, verify locally). See gateway-identity-token-design §3.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

// Symbols that would mean the tenant bundle holds a secret or a DB path. Note the
// middleware imports IdentityVerifier (public-key verify) but never IdentitySigner.
const FORBIDDEN = [
  'IdentitySigner',
  'ID_SIGNING_JWK',
  'newPgStore',
  'Hyperdrive',
  '@280/backend',
  "from 'pg'",
  'from "pg"',
];

// localImportGraph walks only relative (./) imports from an entry file, returning every
// gateway src module the tenant middleware statically depends on. Package imports
// (@280/contracts) are intentionally not followed: they are pure and shared, and the
// bundler tree-shakes their unused exports.
function localImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const re = /from\s+['"](\.[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      stack.push(resolve(dirname(file), m[1]!.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

describe('tenant middleware trust boundary', () => {
  it('the appworker import graph references no signing key, DB, or backend', () => {
    const files = localImportGraph(resolve(SRC, 'appworker.ts'));
    // Sanity: the graph is non-trivial (it did resolve the real dependencies).
    expect(files.size).toBeGreaterThan(1);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const bad of FORBIDDEN) {
        expect(src.includes(bad), `${file} must not reference ${bad}`).toBe(false);
      }
    }
  });
});
