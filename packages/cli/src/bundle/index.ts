import { buildNextContainer } from './container.js';
import { buildStatic, type Bundle } from './static.js';
import { fail } from './walk.js';
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
        'run two80 init to re-detect, or pass --framework next|static',
      );
  }
}
