import path from 'node:path';
import { readObject, writeObject } from './jsonfile.js';
import { isOurCommand } from './hookcmd.js';
import { arraySection, objectSection } from './merge.js';
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
  const hooks = objectSection(obj, 'hooks', file);
  const groups = arraySection<HookGroup>(hooks, EVENT, file, `hooks.${EVENT}`);
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
function findOurHook(groups: HookGroup[]): CommandHook | undefined {
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (h && typeof h.command === 'string' && isOurCommand(h.command)) return h;
    }
  }
  return undefined;
}
