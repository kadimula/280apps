// bundle turns a built project directory into a deploy Manifest plus the blob
// content it names, ready for the deploy seam's Sync/PutBlob loop. Two
// frameworks: `static` walks the build dir and content-addresses every file;
// `next` runs the pinned OpenNext Cloudflare adapter and wrangler. Spec:
// cli/internal/bundle/bundle.go (Build dispatch). Go is normative.

import { buildNext } from './next.js';
import { buildStatic, type Bundle } from './static.js';
import { fail } from './walk.js';

// Framework names this package can build. Mirrors detect.FrameworkNext /
// FrameworkStatic (cli/internal/detect); duplicated as a constant so bundle has
// no dependency on W2's detect module.
export const Framework = {
  Static: 'static',
  Next: 'next',
} as const;

// build produces a Bundle for a project of the given framework rooted at root.
export function build(root: string, framework: string): Bundle {
  switch (framework) {
    case Framework.Static:
      return buildStatic(root);
    case Framework.Next:
      return buildNext(root);
    default:
      return fail(
        'unknown framework ' + framework,
        'run 280 init to re-detect, or pass --framework next|static',
      );
  }
}

// assetPaths returns the manifest's asset URL paths, for logging (bundle.go
// AssetPaths).
export function assetPaths(m: { assets: { path: string }[] }): string[] {
  return m.assets.map((a) => a.path);
}

export type { Bundle };
export { buildStatic, staticWorker, staticDir } from './static.js';
export {
  buildNext,
  nextBundle,
  cacheKey,
  walkCache,
  checkEnvelope,
  envelopeError,
  checkNativeModules,
  readBundledWorker,
  ensureAdapterConfig,
  requireNextBuild,
  requireNodeToolchain,
} from './next.js';
export { PreflightError, fail, walkAssets, fileExists } from './walk.js';
