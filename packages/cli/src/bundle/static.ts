import { join } from 'node:path';
import type { Digest, Manifest } from '@280/contracts';
import { buildStaticContainer } from './container.js';
import { fail, fileExists } from './walk.js';
export interface Bundle {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
  notes: string[];
  details: string[];
}
export function buildStatic(root: string): Bundle {
  const dir = staticDir(root);
  return buildStaticContainer(root, dir);
}
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
