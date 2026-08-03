// bundle turns a project directory into a deploy Manifest plus the blob content
// it names, ready for the deploy seam's Sync/PutBlob loop. Both frameworks
// produce a container build context: `next` generates a Dockerfile that builds
// and runs the app unchanged; `static` serves a prebuilt site from a container.
// A user Dockerfile at the repo root is the escape hatch (see bundle/container).

import { buildNextContainer } from './container.js';
import { buildStatic, type Bundle } from './static.js';
import { fail } from './walk.js';

// Framework names this package can build. Mirrors detect.FrameworkNext /
// FrameworkStatic (cli/src/detect); duplicated as a constant so bundle has no
// dependency on the detect module.
const Framework = {
  Static: 'static',
  Next: 'next',
} as const;

export function build(root: string, framework: string): Bundle {
  switch (framework) {
    case Framework.Static:
      return buildStatic(root);
    case Framework.Next:
      return buildNextContainer(root);
    default:
      return fail(
        'unknown framework ' + framework,
        'run 280 init to re-detect, or pass --framework next|static',
      );
  }
}
