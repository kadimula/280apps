// Installs a managed plugin for OpenCode: a file we own end to end, so setup
// writes it whole. A MARKER header lets setup tell its own plugin from a foreign
// file at the same path; a foreign file is never overwritten. The plugin injects
// the bare `280` home view as ambient session context.

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './jsonfile.js';
import type { InstallResult } from './result.js';

export const FILE = path.join('.opencode', 'plugin', '280.js');

// Bumping VERSION forces a repair on next setup so the injected logic can evolve.
const MARKER = '280-managed-plugin';
const VERSION = 1;

export function install(root: string, command: string): InstallResult {
  const file = path.join(root, FILE);
  const desired = pluginSource(command);

  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (current !== null && !current.includes(MARKER)) {
    throw new Error(`refusing to overwrite ${FILE}: not a 280-managed plugin`);
  }
  if (current === desired) return { target: 'opencode', action: 'unchanged', path: FILE };

  writeAtomic(file, desired);
  return { target: 'opencode', action: current === null ? 'installed' : 'repaired', path: FILE };
}

// Deterministic in `command`, so an unchanged command yields byte-identical
// output (idempotent no-op) and a path repair yields a diff.
function pluginSource(command: string): string {
  return `// ${MARKER} v${VERSION} — do not edit; regenerate with \`280 setup\`.
// Injects this directory's 280 app state into every OpenCode session at start,
// so the agent can act on the live deploy state without invoking anything first.
import { execFileSync } from "node:child_process";

const COMMAND = ${JSON.stringify(command)};

function homeView(directory) {
  try {
    const [file, ...args] = COMMAND.split(" ");
    return execFileSync(file, args, { cwd: directory, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export const TwoEightyPlugin = async ({ directory }) => {
  return {
    "chat.params": async (_input, output) => {
      const view = homeView(directory);
      if (!view) return;
      const context = "Current 280 app state (from \`280\`):\\n" + view;
      output.system = output.system ? output.system + "\\n\\n" + context : context;
    },
  };
};
`;
}
