// hookcmd resolves the shell command a session-start hook runs to print the
// bare `280` home view. AXI §7 "portable commands": use the PATH-verified
// binary name `280` when it resolves to *this* executable, and fall back to the
// absolute path otherwise, so a global install stays portable while a hook never
// silently runs a different binary. It also recognizes a command as one we wrote
// (any form of `280`, or our own compiled `bin.js` inside the `two80` package)
// so reinstall can repair a stale path instead of appending a duplicate.

import fs from 'node:fs';
import path from 'node:path';

// BinProbe is the filesystem seam hook resolution needs, injected so the merge
// logic is unit-testable without real symlinks. The default binds to node fs.
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

// candidateNames are the on-disk names a `280` bin can take. On Windows the
// launcher is a `.cmd`/`.exe` shim; on unix it is the bare name (a symlink to
// our bin.js). PATHEXT variants beyond these are not npm bin conventions.
function candidateNames(): string[] {
  return process.platform === 'win32' ? ['280.cmd', '280.exe', '280.bat', '280'] : ['280'];
}

// resolveHookCommand returns the command string for the hook. It walks PATH the
// way a shell does — first match wins — and only returns the portable `280` when
// that first match resolves to the same file as this executable. Any other case
// (a different `280` shadowing ours, or no `280` on PATH, e.g. an npx/pnpm shim
// that is a wrapper script rather than a symlink) falls back to the absolute
// path so the hook is unambiguous.
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

// quote wraps a path containing shell-significant whitespace in double quotes so
// the hook command survives a space in the install path. Paths without spaces
// stay bare for readability.
export function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

// program extracts the executable token from a hook command string, unquoting a
// leading double-quoted path. Only the first token matters for identification.
function program(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

// isOurCommand reports whether a hook command was written by this tool, so a
// reinstall repairs it in place rather than appending a duplicate. It matches
// the only two forms resolveHookCommand ever emits: the portable `280` name, and
// our compiled entry, which tsup always writes to `dist/bin.js`. The suffix match
// is path-independent (repair survives a moved install) yet specific enough to
// not flag an unrelated hook: a bare, single-token command ending in
// `dist/bin.js`.
export function isOurCommand(cmd: string): boolean {
  const prog = program(cmd);
  const base = path.basename(prog).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (base === '280') return true;
  return /[\\/]dist[\\/]bin\.js$/.test(prog);
}
