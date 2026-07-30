// Resolves the shell command a session-start hook runs to print the bare `280`
// home view: the portable name `280` when it resolves to this executable, else
// the absolute path, so a hook never silently runs a different binary.

import fs from 'node:fs';
import path from 'node:path';

// Filesystem seam, injected so resolution is unit-testable without real symlinks.
export interface BinProbe {
  realpath(p: string): string; // resolved absolute path; throws if missing
  isFile(p: string): boolean; // exists and is a regular file (follows symlinks)
}

export const nodeProbe: BinProbe = {
  realpath: (p) => fs.realpathSync(p),
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

// On Windows the launcher is a `.cmd`/`.exe` shim; on unix it is the bare name.
function candidateNames(): string[] {
  return process.platform === 'win32' ? ['280.cmd', '280.exe', '280.bat', '280'] : ['280'];
}

// Walks PATH the way a shell does (first match wins) and returns portable `280`
// only when that first match resolves to this executable, else the absolute path.
export function resolveHookCommand(binPath: string, pathEnv: string, probe: BinProbe = nodeProbe): string {
  const target = safeReal(binPath, probe);
  const dirs = pathEnv.split(path.delimiter).filter((d) => d !== '');
  const names = candidateNames();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!probe.isFile(candidate)) continue;
      // First `280` on PATH is what the shell would run; decide on it alone.
      return safeReal(candidate, probe) === target ? '280' : quote(binPath);
    }
  }
  return quote(binPath);
}

function safeReal(p: string, probe: BinProbe): string {
  try {
    return probe.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

// Double-quotes a path containing whitespace so the hook survives a space in the
// install path; bare otherwise.
export function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

function program(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

// Whether a hook command was written by this tool, so a reinstall repairs it
// instead of appending a duplicate. Matches the two forms resolveHookCommand
// emits: the portable `280` name, and our compiled entry at `dist/bin.js`.
export function isOurCommand(cmd: string): boolean {
  const prog = program(cmd);
  const base = path.basename(prog).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (base === '280') return true;
  return /[\\/]dist[\\/]bin\.js$/.test(prog);
}
