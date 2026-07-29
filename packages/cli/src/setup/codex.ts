// codex installs the SessionStart hook for Codex. Two files, per AXI §7 and the
// plan's W9 note: the hook itself lives in project .codex/hooks.json, and Codex
// only runs hooks when `[features].hooks = true` in .codex/config.toml, so setup
// ensures both. hooks.json is JSON-merged (never overwritten) exactly like the
// Claude installer; config.toml is edited with a one-key line-preserving setter
// (setup/toml.ts) so no comment or unrelated key is disturbed. The hooks.json
// schema mirrors the Claude event→groups shape for a single maintainable merge;
// the `[features].hooks` gate is the Codex-specific requirement.

import path from 'node:path';
import { readObject, writeObject, writeAtomic } from './jsonfile.js';
import { ensureFeaturesHooks } from './toml.js';
import { isOurCommand } from './hookcmd.js';
import type { Action, InstallResult } from './result.js';
import fs from 'node:fs';

export const HOOKS_FILE = path.join('.codex', 'hooks.json');
export const CONFIG_FILE = path.join('.codex', 'config.toml');

const EVENT = 'SessionStart';

interface CommandHook {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

// install merges the hook into hooks.json and flips the features gate in
// config.toml. It reports the strongest action across both files: a change to
// either is `installed`/`repaired`; only when both are already correct is it the
// idempotent `unchanged`.
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
  const entries = eventEntries(hooks, file);

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

// ensureFeatureGate sets [features].hooks = true in config.toml, returning
// whether the file changed. A brand-new file is created with just that table.
function ensureFeatureGate(file: string): boolean {
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const { text, changed } = ensureFeaturesHooks(current);
  if (changed) writeAtomic(file, text);
  return changed;
}

function objectSection(obj: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
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

function eventEntries(hooks: Record<string, unknown>, file: string): CommandHook[] {
  const v = hooks[EVENT];
  if (v === undefined) {
    const created: CommandHook[] = [];
    hooks[EVENT] = created;
    return created;
  }
  if (!Array.isArray(v)) {
    throw new Error(`refusing to modify ${file}: hooks.${EVENT} is not an array`);
  }
  return v as CommandHook[];
}
