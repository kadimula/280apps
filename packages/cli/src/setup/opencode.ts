// opencode installs a managed plugin for OpenCode. Unlike the Claude/Codex JSON
// hooks, OpenCode's integration point is a plugin file we own end to end, so the
// "merge" is simpler and safer: we write the whole file. It carries a marker
// header (MARKER) so setup can tell its own managed plugin apart from a foreign
// file that happens to share the path — a foreign file is never overwritten. The
// plugin injects the bare `280` home view as ambient session context (AXI §7:
// prefer system-context injection over adding a custom tool), running the same
// resolved command the other agents' hooks use.

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './jsonfile.js';
import type { InstallResult } from './result.js';

// FILE is the project-scoped plugin path (directory-scoped per AXI §7).
export const FILE = path.join('.opencode', 'plugin', '280.js');

// MARKER identifies a plugin file this tool manages. Bumping VERSION forces a
// repair on next setup so the injected logic can evolve.
const MARKER = '280-managed-plugin';
const VERSION = 1;

// install writes (or repairs) the managed plugin. An existing file without our
// marker is a foreign file and is left untouched with a hard error, rather than
// clobbered.
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

// pluginSource renders the managed plugin. It is deterministic in `command`, so
// an unchanged command yields byte-identical output (idempotent no-op) and a
// changed command (path repair) yields a diff. The plugin shells out to the
// resolved 280 command and appends its home view to the session's system context
// at session start.
export function pluginSource(command: string): string {
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
