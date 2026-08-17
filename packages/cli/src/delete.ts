import { DeployCode } from '@280/contracts';
import { asError } from './output.js';
import * as config from './config.js';
import * as output from './output.js';
import type { Ctx } from './app.js';
const DELETE_HELP = `two80 delete - destroy this project's app: its URL, content, and data

Flags:
  --yes <name>   confirm; must name the app. Bare two80 delete prints the name
                 and deletes nothing.

Examples:
  two80 delete
  two80 delete --yes my-app`;
export async function cmdDelete(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;
  const p = output.parseFlags(s, 'delete', ctx.args, [{ name: 'yes', type: 'string' }]);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, DELETE_HELP);
    return output.ExitOK;
  }
  const { cfg, found } = config.load(ctx.env.root);
  if (!found || cfg.appId === '') {
    return noop(ctx, cfg, found, 'this directory has no 280 app');
  }
  const port = await ctx.deps.openPort();
  let res;
  try {
    res = await port.delete({ appId: cfg.appId, confirm: p.values.yes as string });
  } catch (e) {
    if (asError(e).code !== DeployCode.NoSuchApp) throw e;
    return noop(ctx, cfg, found, 'app already deleted');
  }
  if (!res.deleted) {
    throw output.fail(
      DeployCode.ConfirmationRequired,
      `deleting ${res.app.slug} destroys the app, its URL, and its data`,
      `run two80 delete --yes ${res.app.slug}`,
    );
  }
  cfg.appId = '';
  config.save(ctx.env.root, cfg);
  return output.result(s, { deleted: true, slug: res.app.slug, appId: res.app.id });
}
function noop(ctx: Ctx, cfg: config.Config, found: boolean, note: string): number {
  if (found && cfg.appId !== '') {
    cfg.appId = '';
    config.save(ctx.env.root, cfg);
  }
  return output.result(ctx.env.streams, {
    deleted: false,
    note: `${note} (no-op)`,
    help: ['Run `two80 push` to deploy an app'],
  });
}
