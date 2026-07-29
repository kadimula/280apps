// delete destroys this project's app. It is the only command that takes
// something away, and the only one that refuses to act on its own.
//
// The confirmation carries the app's name (`--yes <name>`): an agent cleaning
// up, or a half-understood instruction, cannot produce the command without
// first being told which app it is destroying. A bare `280 delete` never
// deletes; it fails confirmation_required with the exact command that would, so
// the agent has something precise to put in front of its user before anything
// is gone.
//
// delete is idempotent (AXI §6): when there is nothing to delete — no app bound
// to this directory, or a binding the server no longer knows — the desired state
// already holds, so the answer is an exit-0 no-op, not an error. This diverges
// from Go's exit-1 no_such_app on purpose.

import { DeployCode } from '@280/contracts';
import { asError } from './output.js';
import * as config from './config.js';
import * as output from './output.js';
import type { Ctx } from './app.js';

export const DELETE_HELP = `280 delete - destroy this project's app: its URL, content, and data

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
    // A binding the server no longer knows (deleted elsewhere): the desired
    // state holds. Unbind so the next push deploys instead of failing on it.
    if (asError(e).code !== DeployCode.NoSuchApp) throw e;
    return noop(ctx, cfg, found, 'app already deleted');
  }

  // The dry run (empty or wrong confirm). The server named the app; the CLI
  // turns that into the command that would finish the job. One stream: the
  // agent reads a single confirmation_required error carrying the exact fix.
  if (!res.deleted) {
    throw output.fail(
      DeployCode.ConfirmationRequired,
      `deleting ${res.app.slug} destroys the app, its URL, and its data`,
      `run 280 delete --yes ${res.app.slug}`,
    );
  }

  // Unbind the directory, keeping name and framework: the project is still a
  // project, it just no longer has an app. Leaving a dead appId here would make
  // the next push fail no_such_app instead of deploying.
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
