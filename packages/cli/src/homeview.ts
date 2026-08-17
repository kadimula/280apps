import os from 'node:os';
import { encode } from '@toon-format/toon';
import * as config from './config.js';
import * as credentials from './credentials.js';
import * as output from './output.js';
import type { Ctx } from './app.js';
export const DESCRIPTION = 'Deploy and share your app with one command.';
export interface HomeParams {
  binPath: string; // absolute path of the current executable
  root: string; // working directory (project root)
  api: string; // resolved platform endpoint
}
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
export function cmdHome(ctx: Ctx): number {
  output.text(ctx.env.streams, render({ binPath: ctx.env.binPath, root: ctx.env.root, api: ctx.api }));
  return output.ExitOK;
}
function appLine(found: boolean, cfg: config.Config): string {
  if (!found) return 'none in this directory';
  const base = `${cfg.name} (${cfg.framework})`;
  return cfg.appId !== '' ? `${base} deployed` : `${base} not yet deployed`;
}
function helpFor(found: boolean, cfg: config.Config): string[] {
  if (!found) return ['Run `two80 push` to create and deploy this app'];
  if (cfg.appId === '') return ['Run `two80 push` to deploy'];
  return ['Run `two80 push` to redeploy', `Run \`two80 delete --yes ${cfg.name}\` to remove it`];
}
function collapseHome(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + '/'))) {
    return '~' + p.slice(home.length);
  }
  return p;
}
