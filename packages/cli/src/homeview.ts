// homeview is the bare `280` content-first view (AXI §8, plan §3a): when an
// agent runs the CLI with no arguments it sees live, directory-scoped state it
// can act on, not a usage manual. This same payload is what the session-start
// hook (W9) injects, so it is ruthlessly budgeted to ~10 lines and never dials
// the network: login state is read from the credentials file, not redeemed.

import os from 'node:os';
import { encode } from '@toon-format/toon';
import * as config from './config.js';
import * as credentials from './credentials.js';
import * as output from './output.js';
import type { Ctx } from './app.js';

// DESCRIPTION is the tool's one-sentence identity. Exported so the W9 skill
// generator (setup/skill.ts) renders the same line the home view prints, keeping
// the installable skill a single source of truth with this view (AXI §7).
export const DESCRIPTION = 'Deploy and share your app with one command.';

export interface HomeParams {
  binPath: string; // absolute path of the current executable
  root: string; // working directory (project root)
  api: string; // resolved platform endpoint
}

// render builds the home view as a TOON document. Pure and offline so it is
// safe to run on every session start; returns the string without a trailing
// newline so callers control framing.
export function render(params: HomeParams): string {
  const { cfg, found } = config.load(params.root);
  const { creds, loggedIn } = credentials.load();

  const doc: Record<string, unknown> = {
    bin: collapseHome(params.binPath),
    description: DESCRIPTION,
    app: appLine(found, cfg),
    login: loggedIn && creds.api === params.api ? 'logged in' : 'not logged in',
    help: helpFor(found, cfg),
  };
  return encode(doc);
}

// cmdHome renders the home view to stdout. Exit 0: the absence of a command is
// answered with state, not treated as an error.
export function cmdHome(ctx: Ctx): number {
  output.text(ctx.env.streams, render({ binPath: ctx.env.binPath, root: ctx.env.root, api: ctx.api }));
  return output.ExitOK;
}

function appLine(found: boolean, cfg: config.Config): string {
  if (!found) return 'none in this directory';
  // No comma: the TOON encoder would quote a value containing one, and the home
  // view reads cleaner unquoted.
  const base = `${cfg.name} (${cfg.framework})`;
  return cfg.appId !== '' ? `${base} deployed` : `${base} not yet deployed`;
}

function helpFor(found: boolean, cfg: config.Config): string[] {
  if (!found) return ['Run `280 push` to create and deploy this app'];
  if (cfg.appId === '') return ['Run `280 push` to deploy'];
  return ['Run `280 push` to redeploy', `Run \`280 delete --yes ${cfg.name}\` to remove it`];
}

// collapseHome rewrites a leading home directory to `~` so the bin path is
// stable and readable across machines (AXI §10).
function collapseHome(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + '/'))) {
    return '~' + p.slice(home.length);
  }
  return p;
}
