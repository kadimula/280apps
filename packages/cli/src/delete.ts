// delete destroys this project's app: the only command that takes something away
// and the only one that refuses to act on its own. The `--yes <name>` confirmation
// forces the caller to name the app; a bare `280 delete` fails confirmation_required
// with the exact command that would delete, and never deletes.
// Idempotent (AXI §6): nothing to delete is an exit-0 no-op, not an error
// (diverges from Go's exit-1 no_such_app).

import { DeployCode } from '@280/contracts';
import { asError } from './output.js';
import * as config from './config.js';
import * as output from './output.js';
import type { Ctx } from './app.js';

const DELETE_HELP = `280 delete - destroy this project's app: its URL, content, and data

Flags:
  --yes <name>   confirm; must name the app. Bare 280 delete prints the name
                 and deletes nothing.

Examples:
  280 delete
  280 delete --yes my-app`;

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
    // A binding the server no longer knows (deleted elsewhere): desired state
    // holds. Unbind so the next push deploys instead of failing on it.
    if (asError(e).code !== DeployCode.NoSuchApp) throw e;
    return noop(ctx, cfg, found, 'app already deleted');
  }

  // Dry run (empty or wrong confirm): the server named the app, the CLI turns
  // that into the exact command that would finish the job.
  if (!res.deleted) {
    throw output.fail(
      DeployCode.ConfirmationRequired,
      `deleting ${res.app.slug} destroys the app, its URL, and its data`,
      `run 280 delete --yes ${res.app.slug}`,
    );
  }

  // Unbind the directory, keeping name and framework: leaving a dead appId would
  // make the next push fail no_such_app instead of deploying.
  cfg.appId = '';
  config.save(ctx.env.root, cfg);

  return output.result(s, { deleted: true, slug: res.app.slug, appId: res.app.id });
}

// noop acknowledges a delete whose end state already holds: nothing exists.
// Exit 0, and any stale binding is cleared along the way.
function noop(ctx: Ctx, cfg: config.Config, found: boolean, note: string): number {
  if (found && cfg.appId !== '') {
    cfg.appId = '';
    config.save(ctx.env.root, cfg);
  }
  return output.result(ctx.env.streams, {
    deleted: false,
    note: `${note} (no-op)`,
    help: ['Run `280 push` to deploy an app'],
  });
}
