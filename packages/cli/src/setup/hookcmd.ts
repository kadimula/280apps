import fs from 'node:fs';
import path from 'node:path';
export interface BinProbe {
  realpath(p: string): string; // resolved absolute path; throws if missing
  isFile(p: string): boolean; // exists and is a regular file (follows symlinks)
}
const nodeProbe: BinProbe = {
  realpath: (p) => fs.realpathSync(p),
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
};
function candidateNames(): string[] {
  return process.platform === 'win32' ? ['two80.cmd', 'two80.exe', 'two80.bat', 'two80'] : ['two80'];
}
export function resolveHookCommand(binPath: string, pathEnv: string, probe: BinProbe = nodeProbe): string {
  const target = safeReal(binPath, probe);
  const dirs = pathEnv.split(path.delimiter).filter((d) => d !== '');
  const names = candidateNames();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!probe.isFile(candidate)) continue;
      return safeReal(candidate, probe) === target ? 'two80' : quote(binPath);
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
export function isOurCommand(cmd: string): boolean {
  const prog = program(cmd);
  const base = path.basename(prog).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (base === 'two80' || base === '280') return true;
  return /[\\/]dist[\\/]bin\.js$/.test(prog);
}
