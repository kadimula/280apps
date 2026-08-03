// config owns .280/config.json, the committed per-project file binding a working
// directory to a 280 app (the primary duplicate-app defense). appId is filled by
// the first push; clientRef is a create-dedup nonce written at init when there is
// no git remote. Spec: cli/internal/config/config.go; Go is normative.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR = '.280';

const FILE = path.join(DIR, 'config.json');

// Config is the committed project<->app binding. JSON field names mirror Go so a
// config written by either CLI reads on the other.
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

// load reads config.json. found is false (no error) when the project is not yet
// initialized. Absent fields become zero values so a partial file never crashes.
export function load(root: string): Loaded {
  let raw: string;
  try {
    raw = fs.readFileSync(pathOf(root), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cfg: zero(), found: false };
    }
    throw e;
  }
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

// save writes config.json atomically (temp file + rename) so a crash mid-write
// never leaves a truncated config: appId must persist before any blob upload.
export function save(root: string, cfg: Config): void {
  const dir = path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  // Match Go json.MarshalIndent(cfg, "", "  ") + trailing newline.
  const body =
    JSON.stringify(
      { name: cfg.name, framework: cfg.framework, appId: cfg.appId, clientRef: cfg.clientRef },
      null,
      2,
    ) + '\n';
  const tmp = path.join(dir, `config-${randomBytes(8).toString('hex')}.json`);
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, pathOf(root));
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; the original error is what matters
    }
    throw e;
  }
}

function zero(): Config {
  return { name: '', framework: '', appId: '', clientRef: '' };
}
