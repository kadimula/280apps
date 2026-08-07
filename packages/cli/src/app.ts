// app is the CLI's command surface: dispatch, global flags, and the thin wiring
// from each command to the module that does the work. Every result and error
// flows through output, so the agent-facing contract is uniform.
// Spec: cli/internal/app/app.go and push.go (cmdPush); Go is normative.

import type { Port } from '@280/contracts';
import * as output from './output.js';
import type { Streams } from './output.js';
import type { AuthClient } from './login.js';
import type { Bundle } from './push.js';
import * as push from './push.js';
import { ensureInit } from './init.js';
import { cmdInit } from './init.js';
import { cmdDelete } from './delete.js';
import { cmdWhoami } from './whoami.js';
import { cmdLogin } from './login.js';
import { cmdHome } from './homeview.js';
import { cmdSetup } from './setup/index.js';

// VERSION is injected from package.json at build time (tsup) and test time
// (vitest) via a define, so package.json is the single source of truth.
declare const __CLI_VERSION__: string;
export const VERSION = __CLI_VERSION__;

// DEFAULT_API is the platform endpoint; override with TWO80_API.
const DEFAULT_API = 'https://api.280apps.com';

// Env is the process environment one invocation runs in, injected so tests need
// no real stdio or working directory.
export interface Env {
  args: string[];
  root: string; // working directory (project root)
  streams: Streams;
  binPath: string; // absolute path of the current executable, for the home view
}

// Deps is the CLI's outward-facing seam: the pieces that touch the network, the
// filesystem beyond the project, or subprocesses. Injected so every command is
// testable offline.
export interface Deps {
  buildBundle(root: string, framework: string): Promise<Bundle>;
  openPort(): Promise<Port>; // TWO80_FAKE fake or authed HTTP client; may throw authorization_pending
  authClient(api: string): AuthClient;
  gitRemote(root: string): string; // origin URL for fingerprint dedup; "" when none
  now(): number; // unix seconds
}

// Ctx is what a command handler receives, with global flags already stripped
// from args.
export interface Ctx {
  env: Env;
  deps: Deps;
  api: string;
  args: string[];
}

export function apiBase(): string {
  const v = process.env.TWO80_API;
  if (v && v !== '') return v.replace(/\/+$/, '');
  return DEFAULT_API;
}

// run dispatches one invocation and returns an exit code. It is the single place
// thrown failures become rendered errors, so any command can throw and get
// uniform exit-1 output.
export async function run(env: Env, deps: Deps): Promise<number> {
  const api = apiBase();
  const s = env.streams;

  if (env.args.length === 0) {
    return cmdHome({ env, deps, api, args: [] });
  }

  let cmd = env.args[0]!;
  const rest = env.args.slice(1);
  if (cmd === '--version' || cmd === '-v') cmd = 'version';
  else if (cmd === '--help' || cmd === '-h') cmd = 'help';
  // A flag where a command belongs is misuse, not an unknown command: reject it
  // by name with the global flags inline.
  else if (cmd.startsWith('-')) return output.usageError(s, 'two80', cmd, ['--version', '--help']);

  const ctx: Ctx = { env, deps, api, args: rest };
  try {
    return await dispatch(cmd, ctx);
  } catch (e) {
    return output.error(s, e);
  }
}

async function dispatch(cmd: string, ctx: Ctx): Promise<number> {
  switch (cmd) {
    case 'help':
      output.text(ctx.env.streams, GLOBAL_HELP);
      return output.ExitOK;
    case 'version':
      return output.result(ctx.env.streams, { version: VERSION });
    case 'init':
      return cmdInit(ctx);
    case 'push':
      return cmdPush(ctx);
    case 'whoami':
      return cmdWhoami(ctx);
    case 'login':
      return cmdLogin(ctx);
    case 'delete':
      return cmdDelete(ctx);
    case 'setup':
      return cmdSetup(ctx);
    case 'update':
      return cmdUpdate(ctx);
    case 'list':
    case 'logs':
    case 'share':
    case 'open':
    case 'link':
    case 'secrets':
      // Honest not_implemented failures, dropped from help so a public package
      // does not leak the roadmap.
      throw output.fail('not_implemented', `two80 ${cmd} is not implemented yet`, 'run two80 help for what works today');
    default:
      throw output.fail('unknown_command', `unknown command "${cmd}"`, 'run two80 help');
  }
}

// cmdPush is the product's one command: auto-init, build the bundle, open the
// platform adapter, and run the deploy loop to a live URL. Progress narrates on
// stderr; only the final result lands on stdout.
async function cmdPush(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;
  const p = output.parseFlags(s, 'push', ctx.args, [
    { name: 'name', type: 'string' },
    { name: 'framework', type: 'string' },
    { name: 'new', type: 'bool' },
  ]);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, PUSH_HELP);
    return output.ExitOK;
  }

  const { cfg, created } = ensureInit(ctx.env.root, p.values.name as string, p.values.framework as string);
  if (created) output.progress(s, `initialized (${cfg.framework}, ${cfg.name})`);

  const bundle = await ctx.deps.buildBundle(ctx.env.root, cfg.framework);
  for (const note of bundle.notes) output.progress(s, note);

  const port = await ctx.deps.openPort();

  const res = await push.run(
    port,
    cfg,
    bundle,
    {
      root: ctx.env.root,
      gitRemote: ctx.deps.gitRemote(ctx.env.root),
      forceNew: p.values.new as boolean,
      backoffMs: 500,
    },
    {
      onResolve: (app, r) => {
        if (r === 'created') output.progress(s, `created app ${app.slug}`);
        else if (r === 'fingerprint_linked') output.progress(s, `linked to existing app ${app.slug} (${app.id})`);
      },
      onUpload: (done, total) => output.progress(s, `uploaded ${done}/${total}`),
      onWait: () => output.progress(s, 'activating'),
      onSecretNotice: (notice) => output.progress(s, notice),
    },
  );

  if (res.notice !== '') output.progress(s, res.notice);

  return output.result(s, {
    url: res.url,
    appId: res.app.id,
    slug: res.app.slug,
    help: [`Run \`two80 delete --yes ${res.app.slug}\` to remove it`],
  });
}

// cmdUpdate is a hint only: self-update is gone, the CLI ships via npx.
function cmdUpdate(ctx: Ctx): number {
  return output.result(ctx.env.streams, {
    update: 'two80 ships via npx; there is no self-update',
    help: ['Run `npx two80@latest push` to run the latest'],
  });
}

const PUSH_HELP = `two80 push - build, deploy, and print the live URL (runs init if new)

Flags:
  --name <slug>             app name on first init (default: package.json name)
  --framework next|static   skip detection on first init
  --new                     force a fresh app instead of linking an existing one

Examples:
  two80 push
  two80 push --new
  two80 push --name my-app --framework next`;

// GLOBAL_HELP is the agent's command reference, trimmed to shipped commands so a
// public package does not advertise a roadmap.
const GLOBAL_HELP = `two80 - Deploy and share your app with one command.

Usage:
  two80 push [flags]    build, deploy, print the live URL (runs init if new)
    --name <slug>             app name on first init (default: package.json name)
    --framework next|static   skip detection on first init
    --new                     force a fresh app instead of linking an existing one

  two80 init [flags]    detect framework, write .280/config.json (push does this for you)
    --name <slug>             app name (default: package.json name)
    --framework next|static   skip detection

  two80 delete          destroy this project's app: its URL, content, and data
    --yes <name>              confirm; must name the app. Bare two80 delete prints
                              the name and deletes nothing.

  two80 whoami          print auth state
  two80 login           authenticate this machine; prints a link to show your user,
                      then re-run to finish. Never waits.
  two80 setup           register a session-start hook (Claude Code, Codex, OpenCode)
                      so the agent sees this app's state at session start
  two80 version         print the CLI version
  two80 help            print this help

Global flags:
  --version, -v       print version
  --help, -h          print this help

Bare two80 prints this directory's app state. Every error carries a runnable fix.
Exit codes: 0 ok, 1 failure (carries a fix), 2 bad flags or args.
Docs: https://280apps.com`;
