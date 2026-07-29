// setup is `280 setup`: the explicit, opt-in command that wires 280 into an
// agent's session lifecycle (AXI §7). It registers a SessionStart hook that runs
// the bare `280` home view — so every session opens already showing this
// directory's app state — for Claude Code, Codex, and OpenCode, and installs the
// on-demand skill. Everything it writes is JSON-merged or managed-file safe: it
// never overwrites a user's config, a re-run with an unchanged path is a silent
// no-op, and a moved binary is repaired in place. It is directory-scoped and
// token-budgeted: the home view IS the hook payload, no second format.

import fs from 'node:fs';
import type { Ctx } from '../app.js';
import * as output from '../output.js';
import { resolveHookCommand } from './hookcmd.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as opencode from './opencode.js';
import * as skill from './skill.js';
import type { InstallResult } from './result.js';

// cmdSetup runs the command. Three modes, selected by flag:
//   (default)  install/repair hooks for all three agents + the skill
//   --check    verify the committed skill is fresh (CI staleness gate); exit 1 if not
//   --write    regenerate the committed skill file (maintenance; used by --check's fix)
export function cmdSetup(ctx: Ctx): number {
  const s = ctx.env.streams;
  const p = output.parseFlags(s, 'setup', ctx.args, [
    { name: 'check', type: 'bool' },
    { name: 'write', type: 'bool' },
  ]);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, SETUP_HELP);
    return output.ExitOK;
  }

  if (p.values.check) return checkSkill(ctx);
  if (p.values.write) return writeSkill(ctx);
  return installAll(ctx);
}

function installAll(ctx: Ctx): number {
  const s = ctx.env.streams;
  const command = resolveHookCommand(ctx.env.binPath, process.env.PATH ?? '');
  const results: InstallResult[] = [
    claude.install(ctx.env.root, command),
    codex.install(ctx.env.root, command),
    opencode.install(ctx.env.root, command),
    skill.install(ctx.env.root),
  ];

  return output.result(s, {
    setup: `hooks for claude, codex, opencode + skill`,
    installed: results.map((r) => ({ target: r.target, action: r.action, path: r.path })),
    help: ['Restart the agent session so the SessionStart hook loads this directory’s app state'],
  });
}

// checkSkill is the CI staleness gate. Fresh: exit 0. Stale or missing: a
// structured failure whose fix regenerates the committed file, exit 1.
function checkSkill(ctx: Ctx): number {
  const s = ctx.env.streams;
  const r = skill.check();
  if (r.fresh) return output.result(s, { skill: 'up to date', path: r.path });
  throw output.fail(
    'stale_skill',
    'the committed SKILL.md is out of date with the CLI',
    'run 280 setup --write to regenerate it, then commit the change',
  );
}

// writeSkill regenerates the committed skill from the generator. A maintenance
// action, reported self-contained (no next-step help).
function writeSkill(ctx: Ctx): number {
  const s = ctx.env.streams;
  const path = skill.committedPath();
  fs.writeFileSync(path, skill.generate());
  return output.result(s, { wrote: path });
}

const SETUP_HELP = `280 setup - register a session-start hook (Claude Code, Codex, OpenCode) + install the skill

Runs the bare \`280\` home view at session start so the agent sees this
directory's app state without invoking anything. Opt-in, idempotent, and
directory-scoped: it merges into your agent config files, never overwrites them.

Flags:
  --check     verify the committed SKILL.md is up to date (for CI); exit 1 if stale
  --write     regenerate the committed SKILL.md (maintenance)

Examples:
  280 setup
  280 setup --check`;

export { SETUP_HELP };
