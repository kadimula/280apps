// install / repair / no-op across Claude Code, Codex, OpenCode plus the skill
// generator; merge tests assert pre-existing user config survives untouched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, tmpHome, tmpProject, parseToon } from './helpers.js';
import { resolveHookCommand, isOurCommand, quote, type BinProbe } from '../src/setup/hookcmd.js';
import * as claude from '../src/setup/claude.js';
import * as codex from '../src/setup/codex.js';
import * as opencode from '../src/setup/opencode.js';
import * as skill from '../src/setup/skill.js';
import { ensureFeaturesHooks } from '../src/setup/toml.js';

const prev = process.env.TWO80_HOME;
beforeEach(() => {
  process.env.TWO80_HOME = tmpHome();
});
afterEach(() => {
  if (prev === undefined) delete process.env.TWO80_HOME;
  else process.env.TWO80_HOME = prev;
});

const CMD = '280';
const ABS = '/opt/two80/dist/bin.js';

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function write(root: string, rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('hookcmd.resolveHookCommand', () => {
  function probe(map: Record<string, string>, files: string[]): BinProbe {
    return {
      realpath: (p) => map[p] ?? p,
      isFile: (p) => files.includes(p),
    };
  }
  // Build paths/PATH through node's path module so tests run on Windows and
  // POSIX; resolveHookCommand joins with path.join, so probe keys must match.
  const bin = path.resolve('/opt/two80/dist/bin.js');
  const binDir = path.resolve('/usr/local/bin');
  const candidate = path.join(binDir, '280');
  const PATH = [binDir, path.resolve('/usr/bin')].join(path.delimiter);

  it('returns the portable name when PATH 280 resolves to this executable', () => {
    const p = probe({ [candidate]: bin, [bin]: bin }, [candidate]);
    expect(resolveHookCommand(bin, PATH, p)).toBe('280');
  });

  it('falls back to the absolute path when a different 280 shadows ours', () => {
    const other = path.resolve('/somewhere/else/280');
    const p = probe({ [candidate]: other, [bin]: bin }, [candidate]);
    expect(resolveHookCommand(bin, PATH, p)).toBe(bin);
  });

  it('falls back to the absolute path when no 280 is on PATH', () => {
    const p = probe({ [bin]: bin }, []);
    expect(resolveHookCommand(bin, PATH, p)).toBe(bin);
  });

  it('quotes an absolute path containing spaces', () => {
    const spaced = path.resolve('/opt/my apps/two80/dist/bin.js');
    const p = probe({ [spaced]: spaced }, []);
    expect(resolveHookCommand(spaced, PATH, p)).toBe(`"${spaced}"`);
  });
});

describe('hookcmd.isOurCommand', () => {
  it('recognizes the portable name and our compiled entry, in any location', () => {
    expect(isOurCommand('280')).toBe(true);
    expect(isOurCommand('/usr/local/bin/280')).toBe(true);
    expect(isOurCommand('/opt/two80/dist/bin.js')).toBe(true);
    expect(isOurCommand('/repo/packages/cli/dist/bin.js')).toBe(true); // dev path, no "two80"
    expect(isOurCommand('"/opt/my apps/two80/dist/bin.js"')).toBe(true); // quoted
  });
  it('does not flag unrelated commands', () => {
    expect(isOurCommand('node server.js')).toBe(false);
    expect(isOurCommand('/usr/bin/othertool')).toBe(false);
    expect(isOurCommand('/opt/other/dist/index.js')).toBe(false);
  });
  it('quote wraps only paths with spaces', () => {
    expect(quote('/a/b/280')).toBe('/a/b/280');
    expect(quote('/a b/280')).toBe('"/a b/280"');
  });
});

describe('claude install', () => {
  it('installs into a directory with no settings', () => {
    const root = tmpProject();
    const r = claude.install(root, CMD);
    expect(r.action).toBe('installed');
    const obj = JSON.parse(read(root, claude.FILE));
    expect(obj.hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: '280' });
  });

  it('merges into existing settings, preserving unrelated keys and hooks', () => {
    const root = tmpProject();
    write(
      root,
      claude.FILE,
      JSON.stringify(
        {
          $schema: 'https://json.schemastore.org/claude-code-settings.json',
          model: 'opus',
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'my-linter' }] }],
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
          },
        },
        null,
        2,
      ),
    );
    const r = claude.install(root, CMD);
    expect(r.action).toBe('installed');
    const obj = JSON.parse(read(root, claude.FILE));
    expect(obj.model).toBe('opus');
    expect(obj.$schema).toContain('schemastore');
    expect(obj.hooks.PreToolUse[0].hooks[0].command).toBe('my-linter');
    const groups = obj.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    const cmds = groups.flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds).toContain('echo hi');
    expect(cmds).toContain('280');
    expect(obj.hooks.SessionStart).toHaveLength(2);
  });

  it('is a silent no-op on identical re-run', () => {
    const root = tmpProject();
    claude.install(root, CMD);
    const before = read(root, claude.FILE);
    const r = claude.install(root, CMD);
    expect(r.action).toBe('unchanged');
    expect(read(root, claude.FILE)).toBe(before);
  });

  it('repairs a moved binary path in place, without duplicating', () => {
    const root = tmpProject();
    claude.install(root, ABS); // old absolute install
    const r = claude.install(root, CMD); // reinstall, now on PATH
    expect(r.action).toBe('repaired');
    const obj = JSON.parse(read(root, claude.FILE));
    expect(obj.hooks.SessionStart).toHaveLength(1);
    expect(obj.hooks.SessionStart[0].hooks[0].command).toBe('280');
  });

  it('refuses to modify a settings file whose hooks are malformed', () => {
    const root = tmpProject();
    write(root, claude.FILE, JSON.stringify({ hooks: [] })); // hooks must be an object
    expect(() => claude.install(root, CMD)).toThrow(/refusing to modify/);
  });

  it('refuses to modify a settings file that is not JSON', () => {
    const root = tmpProject();
    write(root, claude.FILE, 'not json at all');
    expect(() => claude.install(root, CMD)).toThrow(/not valid JSON/);
  });
});

describe('codex install', () => {
  it('installs the hook and flips the features gate', () => {
    const root = tmpProject();
    const r = codex.install(root, CMD);
    expect(r.action).toBe('installed');
    const hooks = JSON.parse(read(root, codex.HOOKS_FILE));
    expect(hooks.hooks.SessionStart[0].command).toBe('280');
    expect(read(root, codex.CONFIG_FILE)).toBe('[features]\nhooks = true\n');
  });

  it('preserves existing config.toml content and adds hooks under an existing [features]', () => {
    const root = tmpProject();
    write(root, codex.CONFIG_FILE, '# my config\nmodel = "o3"\n\n[features]\nweb_search = true\n');
    codex.install(root, CMD);
    const toml = read(root, codex.CONFIG_FILE);
    expect(toml).toContain('# my config');
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('web_search = true');
    expect(toml).toContain('hooks = true');
  });

  it('is a silent no-op on identical re-run (both files)', () => {
    const root = tmpProject();
    codex.install(root, CMD);
    const h = read(root, codex.HOOKS_FILE);
    const c = read(root, codex.CONFIG_FILE);
    const r = codex.install(root, CMD);
    expect(r.action).toBe('unchanged');
    expect(read(root, codex.HOOKS_FILE)).toBe(h);
    expect(read(root, codex.CONFIG_FILE)).toBe(c);
  });

  it('repairs a moved binary path in place', () => {
    const root = tmpProject();
    codex.install(root, ABS);
    const r = codex.install(root, CMD);
    expect(r.action).toBe('repaired');
    const hooks = JSON.parse(read(root, codex.HOOKS_FILE));
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.SessionStart[0].command).toBe('280');
  });

  it('merges the hook without disturbing an unrelated codex hook', () => {
    const root = tmpProject();
    write(root, codex.HOOKS_FILE, JSON.stringify({ hooks: { SessionStart: [{ type: 'command', command: 'other' }] } }));
    codex.install(root, CMD);
    const hooks = JSON.parse(read(root, codex.HOOKS_FILE));
    const entries = hooks.hooks.SessionStart as Array<{ command: string }>;
    expect(entries.map((h) => h.command)).toEqual(['other', '280']);
  });
});

describe('toml.ensureFeaturesHooks', () => {
  it('creates a minimal table for an empty file', () => {
    expect(ensureFeaturesHooks('')).toEqual({ text: '[features]\nhooks = true\n', changed: true });
  });
  it('is a no-op when already true', () => {
    const src = '[features]\nhooks = true\n';
    expect(ensureFeaturesHooks(src)).toEqual({ text: src, changed: false });
  });
  it('flips a false value in place, preserving an inline comment', () => {
    const r = ensureFeaturesHooks('[features]\nhooks = false # off\n');
    expect(r.changed).toBe(true);
    expect(r.text).toBe('[features]\nhooks = true # off\n');
  });
  it('recognizes a top-level dotted key', () => {
    expect(ensureFeaturesHooks('features.hooks = true\n')).toEqual({ text: 'features.hooks = true\n', changed: false });
  });
  it('inserts into an existing [features] table', () => {
    const r = ensureFeaturesHooks('[features]\nweb_search = true\n');
    expect(r.text).toBe('[features]\nhooks = true\nweb_search = true\n');
  });
  it('appends a table to a file that has other sections', () => {
    const r = ensureFeaturesHooks('[profile]\nname = "x"\n');
    expect(r.text).toBe('[profile]\nname = "x"\n\n[features]\nhooks = true\n');
  });
  it('refuses an inline features table rather than duplicating', () => {
    expect(() => ensureFeaturesHooks('features = { web_search = true }\n')).toThrow(/inline table/);
  });
});

describe('opencode install', () => {
  it('writes a managed plugin', () => {
    const root = tmpProject();
    const r = opencode.install(root, CMD);
    expect(r.action).toBe('installed');
    const src = read(root, opencode.FILE);
    expect(src).toContain('280-managed-plugin');
    expect(src).toContain('const COMMAND = "280"');
  });
  it('is a silent no-op on identical re-run', () => {
    const root = tmpProject();
    opencode.install(root, CMD);
    const before = read(root, opencode.FILE);
    const r = opencode.install(root, CMD);
    expect(r.action).toBe('unchanged');
    expect(read(root, opencode.FILE)).toBe(before);
  });
  it('repairs when the command path changes', () => {
    const root = tmpProject();
    opencode.install(root, ABS);
    const r = opencode.install(root, CMD);
    expect(r.action).toBe('repaired');
    expect(read(root, opencode.FILE)).toContain('const COMMAND = "280"');
  });
  it('refuses to overwrite a foreign file at the plugin path', () => {
    const root = tmpProject();
    write(root, opencode.FILE, '// someone else\n');
    expect(() => opencode.install(root, CMD)).toThrow(/not a 280-managed plugin/);
  });
});

describe('skill', () => {
  it('generate is deterministic and carries trigger frontmatter + npx examples', () => {
    const a = skill.generate();
    expect(skill.generate()).toBe(a);
    expect(a).toMatch(/^---\nname: 280-deploy\ndescription: /);
    expect(a).toContain('npx -y two80@latest push');
    expect(a).not.toContain('logged in'); // live state stripped
    expect(a).not.toContain('none in this directory');
  });

  it('the committed skill is up to date (mirrors `280 setup --check`)', () => {
    const r = skill.check();
    expect(r.fresh, `stale committed skill at ${r.path}; run \`280 setup --write\``).toBe(true);
  });

  it('installs into the agent skills dir, idempotently', () => {
    const root = tmpProject();
    const r = skill.install(root);
    expect(r.action).toBe('installed');
    expect(read(root, skill.INSTALL_FILE)).toBe(skill.generate());
    expect(skill.install(root).action).toBe('unchanged');
  });
});

describe('280 setup command', () => {
  it('installs all three agents + the skill, then re-runs as no-ops', async () => {
    const root = tmpProject();
    const first = await runCli(['setup'], { root });
    expect(first.code).toBe(0);
    expect(first.out).toContain('installed[4]{target,action,path}');
    for (const rel of [claude.FILE, codex.HOOKS_FILE, codex.CONFIG_FILE, opencode.FILE, skill.INSTALL_FILE]) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
    const second = await runCli(['setup'], { root });
    expect(second.code).toBe(0);
    expect(second.out).toContain('claude,unchanged');
    expect(second.out).toContain('opencode,unchanged');
    expect(second.out).toContain('skill,unchanged');
  });

  it('--check exits 0 when the committed skill is fresh', async () => {
    const r = await runCli(['setup', '--check'], { root: tmpProject() });
    expect(r.code).toBe(0);
    expect(parseToon(r.out).skill).toBe('up to date');
  });

  it('rejects an unknown flag, exit 2', async () => {
    const r = await runCli(['setup', '--nope'], { root: tmpProject() });
    expect(r.code).toBe(2);
    expect(r.out).toContain('unknown flag --nope for `setup`');
  });
});
