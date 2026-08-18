#!/usr/bin/env node
// Auto-bump for @two80/sdk. PR #106 shipped a real SDK fix (googleSheets not-
// ready degrade) but never bumped packages/sdk/package.json, so the tag-gated
// publish workflow had nothing new to publish and the fix silently never
// reached npm (root cause of the google-sheets sample app 500ing whenever
// Sheets is unconnected). Unlike the CLI's check-cli-version-bump.mjs, which
// fails CI and requires a human to hand-edit the version, this runs on every
// push to main and, when a file that ships in the published SDK package
// changed since the last `sdk-v*` tag without an accompanying version bump,
// increments the patch version itself and rewrites package.json. An SDK
// release can then never again depend on someone remembering to bump it.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SDK_DIR = 'packages/sdk';
const PKG_PATH = join(repoRoot, `${SDK_DIR}/package.json`);

// Tracked paths under packages/sdk that npm never ships and are not build
// inputs for the published dist (see `npm pack --dry-run`: package.json +
// README.md + dist/**). A new path not listed here counts as shipping by
// default, failing safe toward bumping.
const NON_SHIPPING = [`${SDK_DIR}/test/`, `${SDK_DIR}/scripts/`, `${SDK_DIR}/RELEASING.md`, `${SDK_DIR}/vitest.config.ts`];

const ships = (path) => !NON_SHIPPING.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

const parse = (v) => String(v).split('.').map(Number);

// Returns true when `a` is a strict semver-core increase over `b`.
const strictlyGreater = (a, b) => {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};

const output = (line) => {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, line + '\n');
};

const tags = git('tag', '-l', 'sdk-v*')
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
  .sort((a, b) => a.replace('sdk-v', '').localeCompare(b.replace('sdk-v', ''), undefined, { numeric: true }));

if (tags.length === 0) {
  console.log('sdk-auto-bump: no sdk-v* tag yet; nothing published to compare against, skipping.');
  output('bumped=false');
  process.exit(0);
}

const lastTag = tags[tags.length - 1];
const publishedVersion = lastTag.replace('sdk-v', '');
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const currentVersion = pkg.version;

const changed = git('diff', '--name-only', `${lastTag}..HEAD`, '--', SDK_DIR)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .filter(ships);

if (changed.length === 0) {
  console.log(`sdk-auto-bump: no published-package changes since ${lastTag}; ok.`);
  output('bumped=false');
  process.exit(0);
}

if (strictlyGreater(currentVersion, publishedVersion)) {
  console.log(`sdk-auto-bump: already bumped (${publishedVersion} -> ${currentVersion}); ok.`);
  output('bumped=false');
  process.exit(0);
}

const [major, minor, patch] = parse(currentVersion);
const next = `${major}.${minor}.${patch + 1}`;
pkg.version = next;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');

console.log(
  `sdk-auto-bump: published-package files changed since ${lastTag} without a version bump; bumped ${currentVersion} -> ${next}.\n` +
    `  changed: ${changed.join(', ')}`,
);
output('bumped=true');
output(`version=${next}`);
