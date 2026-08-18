import type { LogRecord } from '@280/contracts';
import * as config from './config.js';
import * as output from './output.js';
import type { Ctx } from './app.js';

const LEVELS = ['error', 'warn', 'info', 'all'];
const DEFAULT_SINCE = '1h';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const LOGS_HELP = `two80 logs - read your deployed app's server logs

Usage:
  two80 logs [<app>] [flags]

  <app>   app id to read (defaults to this directory's app via .280/config.json)

Flags:
  --since <dur>            look-back window, e.g. 15m, 1h, 24h        (default ${DEFAULT_SINCE})
  --limit <N>              max lines                                  (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT})
  --level error|warn|info|all   level filter                         (default all)
  --digest <id>            resolve a Next.js production digest to its server stack

Examples:
  two80 logs
  two80 logs --since 24h --level error
  two80 logs --digest 3004175247`;

export async function cmdLogs(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;

  // A leading non-flag arg is the app id; everything after is flags.
  let rest = ctx.args;
  let appArg = '';
  if (rest.length > 0 && !rest[0]!.startsWith('-')) {
    appArg = rest[0]!;
    rest = rest.slice(1);
  }

  const p = output.parseFlags(s, 'logs', rest, [
    { name: 'since', type: 'string' },
    { name: 'limit', type: 'string' },
    { name: 'level', type: 'string' },
    { name: 'digest', type: 'string' },
  ]);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, LOGS_HELP);
    return output.ExitOK;
  }

  const { cfg } = config.load(ctx.env.root);
  const appId = appArg !== '' ? appArg : cfg.appId;
  if (appId === '') {
    throw output.fail(
      'no_app',
      'no app to read logs for',
      'run two80 logs <app>, or push from this app directory first',
    );
  }

  const level = ((p.values.level as string) || 'all').toLowerCase();
  if (!LEVELS.includes(level)) {
    throw output.fail('invalid_level', `unknown --level "${level}"`, `use one of ${LEVELS.join(', ')}`);
  }
  const since = (p.values.since as string) || DEFAULT_SINCE;
  const limit = clampLimit(p.values.limit as string);
  const digest = (p.values.digest as string) || '';

  const port = await ctx.deps.openPort();
  const res = await port.logs(appId, { since, limit, level, digest, follow: false });

  if (digest !== '') {
    const hit = res.records.find((r) => r.digest === digest);
    if (hit === undefined) {
      throw output.fail(
        'not_found',
        `no server error found for digest ${digest} in the last ${since}`,
        'widen the window with --since (e.g. --since 24h)',
      );
    }
    return output.result(s, {
      digest: hit.digest,
      message: hit.message,
      path: hit.path,
      time: hit.time,
      stack: hit.stack,
    });
  }

  return output.result(s, {
    app: appId,
    count: res.records.length,
    logs: res.records.map(line),
  });
}

function line(r: LogRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { time: r.time, level: r.level, message: r.message };
  if (r.digest !== '') out.digest = r.digest;
  return out;
}

// clampLimit reads --limit, falling back to the default on a missing or unparseable
// value and capping at the maximum the backend will honor.
function clampLimit(raw: string): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}
