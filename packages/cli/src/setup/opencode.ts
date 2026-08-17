import path from 'node:path';
import { readOptional } from '../fsutil.js';
import { writeAtomic } from './jsonfile.js';
import type { InstallResult } from './result.js';
export const FILE = path.join('.opencode', 'plugin', '280.js');
const MARKER = '280-managed-plugin';
const VERSION = 1;
export function install(root: string, command: string): InstallResult {
  const file = path.join(root, FILE);
  const desired = pluginSource(command);
  const current = readOptional(file) ?? null;
  if (current !== null && !current.includes(MARKER)) {
    throw new Error(`refusing to overwrite ${FILE}: not a 280-managed plugin`);
  }
  if (current === desired) return { target: 'opencode', action: 'unchanged', path: FILE };
  writeAtomic(file, desired);
  return { target: 'opencode', action: current === null ? 'installed' : 'repaired', path: FILE };
}
function pluginSource(command: string): string {
  return `// ${MARKER} v${VERSION} — do not edit; regenerate with \`two80 setup\`.
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
      const context = "Current 280 app state (from \`two80\`):\\n" + view;
      output.system = output.system ? output.system + "\\n\\n" + context : context;
    },
  };
};
`;
}
