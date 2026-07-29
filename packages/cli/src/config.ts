// config owns .280/config.json, the per-project file that binds a working
// directory to a 280 app. It is meant to be committed, so a clone keeps the app
// identity (the primary duplicate-app defense per the deploy seam's Identity
// resolution). appId is filled by the first push; clientRef is a create-dedup
// nonce written at init for projects with no git remote.
// Spec: cli/internal/config/config.go. Go is normative.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// DIR is the project-relative directory holding config.json.
export const DIR = '.280';

// FILE is the config path relative to the project root.
export const FILE = path.join(DIR, 'config.json');

// Config is the committed project<->app binding. JSON field names mirror Go
// exactly (name, framework, appId, clientRef) so a config written by either CLI
// reads on the other.
export interface Config {
  name: string; // slug; app name
  framework: string; // "next" | "static"
  appId: string; // empty until first push resolves it
  clientRef: string; // create-dedup nonce (no-git-remote projects)
}

// pathOf returns the config path under root.
export function pathOf(root: string): string {
  return path.join(root, FILE);
}

export interface Loaded {
  cfg: Config;
  found: boolean;
}

// load reads config.json from root. found is false (no error) when the project
// is not yet initialized. Parsing mirrors Go encoding/json: absent fields become
// zero values so a partial file never crashes the CLI.
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

// save writes config.json under root, creating .280/ as needed. The write is
// atomic (temp file + rename) so a crash mid-write never leaves a truncated
// config, which the deploy seam relies on: appId must persist before any blob
// upload.
export function save(root: string, cfg: Config): void {
  const dir = path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  // Match Go json.MarshalIndent(cfg, "", "  ") + trailing newline: field order
  // is the struct's declared order, two-space indent.
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
