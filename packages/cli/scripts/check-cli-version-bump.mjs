#!/usr/bin/env node
// Forced-bump guard. The published `two80` CLI and the deployed backend gate are
// two halves of one contract: when CLI code ships in `main` but the published
// package is not re-released, `npx two80 push` runs stale code and the backend
// trusts a shape the CLI no longer emits (root cause of the two80@0.4.6 skew,
// where the integration-manifest code landed unreleased and unbound apps went
// Live and 500'd). This fails CI when ANY file that ships in the published CLI
// package changed since the last `cli-v*` tag without a strict version increase
// in packages/cli/package.json, so main can never carry unreleased CLI changes.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIR = 'packages/cli';

// Tracked paths under packages/cli that npm never ships AND that are not build
// inputs for the published `dist` (see `npm pack --dry-run`: the package is
// dist/** + package.json + README.md + skill/**). Everything else under the CLI
// dir counts as published-affecting — src/** compiles into dist, and build
// config (tsup.config.ts, tsconfig.json) changes the built output. A new path
// not listed here counts by default, which fails safe toward forcing a bump.
const NON_SHIPPING = [
  `${CLI_DIR}/test/`,
  `${CLI_DIR}/testdata/`,
  `${CLI_DIR}/scripts/`,
  `${CLI_DIR}/vitest.config.ts`,
  `${CLI_DIR}/RELEASING.md`,
  `${CLI_DIR}/.gitattributes`,
];

const ships = (path) => !NON_SHIPPING.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

const parse = (v) => {
  const [core, pre] = String(v).split('-', 2);
  const nums = core.split('.').map((n) => Number(n));
  return { nums, pre: pre ?? null };
};

// Returns true when `a` is a strict semver increase over `b`.
const strictlyGreater = (a, b) => {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true; // release > prerelease of same core
  if (pb.pre === null) return false;
  return pa.pre > pb.pre;
};

const tags = git('tag', '-l', 'cli-v*')
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
  .sort((a, b) => a.replace('cli-v', '').localeCompare(b.replace('cli-v', ''), undefined, { numeric: true }));

if (tags.length === 0) {
  console.log('cli-version-bump: no cli-v* tag yet; nothing published, skipping.');
  process.exit(0);
}

const lastTag = tags[tags.length - 1];
const publishedVersion = lastTag.replace('cli-v', '');
const currentVersion = JSON.parse(readFileSync(join(repoRoot, `${CLI_DIR}/package.json`), 'utf8')).version;

const changed = git('diff', '--name-only', `${lastTag}..HEAD`, '--', CLI_DIR)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .filter(ships);

if (changed.length === 0) {
  console.log(`cli-version-bump: no published-package changes since ${lastTag}; ok.`);
  process.exit(0);
}

if (!strictlyGreater(currentVersion, publishedVersion)) {
  console.error(
    `cli-version-bump: files that ship in the published two80 package changed since ${lastTag} ` +
      `but packages/cli/package.json is ${currentVersion} (last published ${publishedVersion}).\n` +
      `  changed: ${changed.join(', ')}\n` +
      `  bump packages/cli/package.json (smallest bump: patch, e.g. 0.4.7 -> 0.4.8).\n` +
      `  A pushed cli-v<version> tag then publishes it; merging the bump cuts that tag automatically.`,
  );
  process.exit(1);
}

console.log(
  `cli-version-bump: published-package files changed since ${lastTag}; version bumped ${publishedVersion} -> ${currentVersion}; ok.`,
);
