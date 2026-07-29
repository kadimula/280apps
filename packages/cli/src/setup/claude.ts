// claude installs the SessionStart hook into project .claude/settings.json for
// Claude Code. The hook runs the bare `280` home view so every session opens
// with this directory's app state already in context (AXI §7). The merge never
// overwrites: it parses the existing settings, adds or repairs only our own hook
// entry, and leaves every other key and hook untouched. A settings.json shape it
// does not recognize (hooks not an object, SessionStart not an array) is a hard
// error, not a clobber — corrupting settings.json is the named risk for setup.

import path from 'node:path';
import { readObject, writeObject } from './jsonfile.js';
import { isOurCommand } from './hookcmd.js';
import type { InstallResult } from './result.js';

// FILE is the project-scoped settings path (directory-scoped per AXI §7).
export const FILE = path.join('.claude', 'settings.json');

// EVENT is the Claude Code hook event that fires at session start.
const EVENT = 'SessionStart';

interface CommandHook {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
interface HookGroup {
  hooks?: CommandHook[];
  [k: string]: unknown;
}

// install merges the hook into <root>/.claude/settings.json. command is the
// resolved program string (portable `280` or an absolute path).
export function install(root: string, command: string): InstallResult {
  const file = path.join(root, FILE);
  const obj = readObject(file);

  const hooks = section(obj, 'hooks', file);
  const groups = eventGroups(hooks, file);

  const existing = findOurHook(groups);
  if (existing) {
    if (existing.command === command) return { target: 'claude', action: 'unchanged', path: FILE };
    existing.command = command;
    writeObject(file, obj);
    return { target: 'claude', action: 'repaired', path: FILE };
  }

  groups.push({ hooks: [{ type: 'command', command }] });
  hooks[EVENT] = groups;
  writeObject(file, obj);
  return { target: 'claude', action: 'installed', path: FILE };
}

// section returns obj[key] as a mutable object, creating it when absent and
// refusing when it is present but not an object.
function section(obj: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
  const v = obj[key];
  if (v === undefined) {
    const created: Record<string, unknown> = {};
    obj[key] = created;
    return created;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`refusing to modify ${file}: "${key}" is not an object`);
  }
  return v as Record<string, unknown>;
}

// eventGroups returns hooks.SessionStart as a mutable array, creating it when
// absent and refusing when present but not an array.
function eventGroups(hooks: Record<string, unknown>, file: string): HookGroup[] {
  const v = hooks[EVENT];
  if (v === undefined) {
    const created: HookGroup[] = [];
    hooks[EVENT] = created;
    return created;
  }
  if (!Array.isArray(v)) {
    throw new Error(`refusing to modify ${file}: hooks.${EVENT} is not an array`);
  }
  return v as HookGroup[];
}

// findOurHook locates the command hook this tool previously wrote, across every
// SessionStart group, so a reinstall repairs it in place.
function findOurHook(groups: HookGroup[]): CommandHook | undefined {
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (h && typeof h.command === 'string' && isOurCommand(h.command)) return h;
    }
  }
  return undefined;
}
