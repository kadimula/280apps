// The static path: content-address every file under the resolved build root and
// pair it with a placeholder serving stub for the Worker slot. Spec: bundle.go,
// normative.

import { join } from 'node:path';
import {
  MANIFEST_KIND_BUNDLE,
  digestBytes,
  type BlobInfo,
  type Digest,
  type Manifest,
} from '@280/contracts';
import { fail, fileExists, walkAssets } from './walk.js';

// A manifest plus the bytes for every blob it names, keyed by digest. Notes are
// things the build did to disk that the caller would otherwise only find in git.
export interface Bundle {
  manifest: Manifest;
  content: Map<Digest, Uint8Array>;
  notes: string[];
}

// Placeholder serving stub so a static bundle has a Worker blob. The exact bytes
// are part of the manifest, so they match Go's string verbatim.
export const staticWorker: Uint8Array = Buffer.from(
  '// 280 static serving stub v0\n',
);

export function buildStatic(root: string): Bundle {
  const dir = staticDir(root);
  const content = new Map<Digest, Uint8Array>();

  const wd = digestBytes(staticWorker);
  content.set(wd, staticWorker);

  let assets: BlobInfo[];
  try {
    assets = walkAssets(dir, content);
  } catch (err) {
    fail(
      'could not read the static build: ' + errMessage(err),
      'check the build directory exists and is readable',
    );
  }
  if (assets.length === 0) {
    fail(
      'the static build directory has no files',
      'build your site first, then run 280 push again',
    );
  }

  return {
    manifest: {
      kind: MANIFEST_KIND_BUNDLE,
      worker: { path: '', digest: wd, size: staticWorker.length },
      assets,
      cache: [],
    },
    content,
    notes: [],
  };
}

// Resolves which directory holds the built site: root when it has an index.html,
// else the first conventional build dir that does. Order dist, build, out, public
// is the contract.
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
    'build your site first, then run 280 push again',
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
