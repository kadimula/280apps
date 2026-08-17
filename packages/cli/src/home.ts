import os from 'node:os';
import path from 'node:path';
function dir(): string {
  const h = process.env.TWO80_HOME;
  if (h) return h;
  return path.join(os.homedir(), '.280');
}
export function file(name: string): string {
  return path.join(dir(), name);
}
