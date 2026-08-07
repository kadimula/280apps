// The static path: resolve the built site directory, then hand it to the
// container buildpack, which serves it from a plain Node container. staticDir's
// resolution order (root, then dist/build/out/public) is the contract.

import { join } from 'node:path';
import type { Digest, Manifest } from '@280/contracts';
import { buildStaticContainer } from './container.js';
import { fail, fileExists } from './walk.js';

// A Bundle is a manifest plus the bytes for every blob it names, keyed by
// digest. Notes are things the build produced that the caller would otherwise
// only find by inspecting the context (e.g. a generated Dockerfile).
export interface Bundle {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
  notes: string[];
}

// buildStatic resolves the static build directory and containerizes it.
export function buildStatic(root: string): Bundle {
  const dir = staticDir(root);
  return buildStaticContainer(root, dir);
}

// staticDir resolves which directory holds the built static site: root itself
// when it has an index.html, else the first conventional build dir that does.
// The order — dist, build, out, public — is the contract.
export function staticDir(root: string): string {
  if (fileExists(join(root, 'index.html'))) {
    return root;
  }
  for (const name of ['dist', 'build', 'out', 'public']) {
    const cand = join(root, name);
    if (fileExists(join(cand, 'index.html'))) {
      return cand;
    }
  }
  return fail(
    'no static build with an index.html found',
    'build your site first, then run two80 push again',
  );
}
