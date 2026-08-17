import path from 'node:path';
import { readObject, writeObject, writeAtomic } from './jsonfile.js';
import { readOptional } from '../fsutil.js';
import { ensureFeaturesHooks } from './toml.js';
import { isOurCommand } from './hookcmd.js';
import { arraySection, objectSection } from './merge.js';
import type { Action, InstallResult } from './result.js';
export const HOOKS_FILE = path.join('.codex', 'hooks.json');
export const CONFIG_FILE = path.join('.codex', 'config.toml');
const EVENT = 'SessionStart';
interface CommandHook {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
export function install(root: string, command: string): InstallResult {
  const hookAction = installHook(path.join(root, HOOKS_FILE), command);
  const featureChanged = ensureFeatureGate(path.join(root, CONFIG_FILE));
  let action: Action = hookAction;
  if (hookAction === 'unchanged' && featureChanged) action = 'installed';
  return { target: 'codex', action, path: HOOKS_FILE };
}
function installHook(file: string, command: string): Action {
  const obj = readObject(file);
  const hooks = objectSection(obj, 'hooks', file);
  const entries = arraySection<CommandHook>(hooks, EVENT, file, `hooks.${EVENT}`);
  const existing = entries.find((h) => h && typeof h.command === 'string' && isOurCommand(h.command));
  if (existing) {
    if (existing.command === command) return 'unchanged';
    existing.command = command;
    writeObject(file, obj);
    return 'repaired';
  }
  entries.push({ type: 'command', command });
  hooks[EVENT] = entries;
  writeObject(file, obj);
  return 'installed';
}
function ensureFeatureGate(file: string): boolean {
  const { text, changed } = ensureFeaturesHooks(readOptional(file) ?? '');
  if (changed) writeAtomic(file, text);
  return changed;
}
