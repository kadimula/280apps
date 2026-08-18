import * as config from './config.js';
import * as output from './output.js';
import type { Ctx } from './app.js';

const STATUS_HELP = `two80 status - check your app's platform state

Usage:
  two80 status [<app>] [flags]

  <app>   app id to check (defaults to this directory's app via .280/config.json)

Examples:
  two80 status
  two80 status app_000001`;

export async function cmdStatus(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;

  let rest = ctx.args;
  let appArg = '';
  if (rest.length > 0 && !rest[0]!.startsWith('-')) {
    appArg = rest[0]!;
    rest = rest.slice(1);
  }

  const p = output.parseFlags(s, 'status', rest, []);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, STATUS_HELP);
    return output.ExitOK;
  }

  const { cfg } = config.load(ctx.env.root);
  const appId = appArg !== '' ? appArg : cfg.appId;
  if (appId === '') {
    throw output.fail(
      'no_app',
      'no app to check status for',
      'run two80 status <app>, or push from this app directory first',
    );
  }

  const port = await ctx.deps.openPort();
  const status = await port.appStatus(appId);

  const result: Record<string, unknown> = { state: status.state };
  if (status.url !== '') result.url = status.url;
  if (status.notice !== '') result.notice = status.notice;
  if (status.secretNotice !== '') result.secretNotice = status.secretNotice;
  if (status.integrationNotice !== '') result.integrationNotice = status.integrationNotice;
  if (status.failure) {
    result.message = status.failure.message;
    result.fix = status.failure.fix;
  }

  const help = helpFor(status.state, status);
  if (help.length > 0) result.help = help;

  return status.failure ? output.error(s, status.failure) : output.result(s, result);
}

function helpFor(
  state: string,
  status: { integrationNotice: string; secretNotice: string },
): string[] {
  switch (state) {
    case 'live':
      return ['Run `two80 push` to redeploy'];
    case 'waiting_secrets':
      if (status.integrationNotice !== '') {
        return ['ask your user to connect the integration, then run `two80 push` again'];
      }
      return ['ask your user to configure the missing variables, then run `two80 push` again'];
    case 'activating':
    case 'uploading':
      return ['run `two80 status` again in a moment'];
    case 'failed':
      return ['run `two80 push` again'];
    default:
      return ['Run `two80 push` to deploy'];
  }
}