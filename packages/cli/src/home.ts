// home locates ~/.280, the machine-global directory the CLI keeps its own state
// in: the account token and any in-flight login. It exists so the convention
// (including the TWO80_HOME override the test suite runs on) is stated once
// instead of once per file that needs it. Spec: cli/internal/home/home.go.

import os from 'node:os';
import path from 'node:path';

// dir returns ~/.280, or TWO80_HOME when set. It creates nothing.
export function dir(): string {
  const h = process.env.TWO80_HOME;
  if (h) return h;
  return path.join(os.homedir(), '.280');
}

// file returns the path of name inside dir.
export function file(name: string): string {
  return path.join(dir(), name);
}
