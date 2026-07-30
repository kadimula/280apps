// Turns a built project directory into a deploy Manifest plus the blob content it
// names. Two frameworks: `static` content-addresses the build dir; `next` runs the
// pinned OpenNext adapter and wrangler. Spec: bundle.go (Build), normative.

import { buildNext } from './next.js';
import { buildStatic, type Bundle } from './static.js';
import { fail } from './walk.js';

// Duplicated from detect.FrameworkNext/Static so bundle has no dependency on the
// detect module.
export const Framework = {
  Static: 'static',
  Next: 'next',
} as const;

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
