// Merges a SessionStart hook (runs the bare `two80` home view) into project
// .claude/settings.json, never overwriting: an unrecognized shape is a hard error.

import path from 'node:path';
import { readObject, writeObject } from './jsonfile.js';
import { isOurCommand } from './hookcmd.js';
import type { InstallResult } from './result.js';

export const FILE = path.join('.claude', 'settings.json');

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

function findOurHook(groups: HookGroup[]): CommandHook | undefined {
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (h && typeof h.command === 'string' && isOurCommand(h.command)) return h;
    }
  }
  return undefined;
}
