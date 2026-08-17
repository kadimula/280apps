import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './fsutil.js';
const DIR = '.280';
const FILE = path.join(DIR, 'config.json');
export interface Config {
  name: string; // slug; app name
  framework: string; // "next" | "static"
  appId: string; // empty until first push resolves it
  clientRef: string; // create-dedup nonce (no-git-remote projects)
}
function pathOf(root: string): string {
  return path.join(root, FILE);
}
export interface Loaded {
  cfg: Config;
  found: boolean;
}
export function load(root: string): Loaded {
  const raw = (() => {
    try { return fs.readFileSync(pathOf(root), 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  })();
  if (raw === undefined) return { cfg: zero(), found: false };
  const parsed = JSON.parse(raw) as Partial<Config>;
  return {
    cfg: {
      name: parsed.name ?? '',
      framework: parsed.framework ?? '',
      appId: parsed.appId ?? '',
      clientRef: parsed.clientRef ?? '',
    },
    found: true,
  };
}
export function save(root: string, cfg: Config): void {
  writeJsonAtomic(pathOf(root), {
    name: cfg.name,
    framework: cfg.framework,
    appId: cfg.appId,
    clientRef: cfg.clientRef,
  });
}
function zero(): Config {
  return { name: '', framework: '', appId: '', clientRef: '' };
}
