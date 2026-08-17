import { randomBytes } from 'node:crypto';
import * as config from './config.js';
import * as detect from './detect.js';
import * as output from './output.js';
import type { Ctx } from './app.js';
const INIT_HELP = `two80 init - detect framework, write .280/config.json (push does this for you)

Flags:
  --name <slug>             app name (default: package.json name)
  --framework next|static   skip detection

Examples:
  two80 init
  two80 init --framework next
  two80 init --name my-app --framework static`;
export interface Initialized {
  cfg: config.Config;
  created: boolean;
}
export function ensureInit(root: string, nameOverride: string, frameworkOverride: string): Initialized {
  const { cfg, found } = config.load(root);
  if (found) return { cfg, created: false };
  const framework = frameworkOverride !== '' ? frameworkOverride : detect.framework(root);
  const name = nameOverride !== '' ? detect.slugify(nameOverride) : detect.slug(root);
  const created: config.Config = { name, framework, appId: '', clientRef: newClientRef() };
  config.save(root, created);
  return { cfg: created, created: true };
}
function newClientRef(): string {
  return 'cr_' + randomBytes(16).toString('hex');
}
export function cmdInit(ctx: Ctx): number {
  const p = output.parseFlags(ctx.env.streams, 'init', ctx.args, [
    { name: 'name', type: 'string' },
    { name: 'framework', type: 'string' },
  ]);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(ctx.env.streams, INIT_HELP);
    return output.ExitOK;
  }
  const { cfg, created } = ensureInit(ctx.env.root, p.values.name as string, p.values.framework as string);
  return output.result(ctx.env.streams, {
    framework: cfg.framework,
    name: cfg.name,
    created,
    help: ['Run `two80 push` to deploy'],
  });
}
