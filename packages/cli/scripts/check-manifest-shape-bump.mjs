#!/usr/bin/env node
// Publish-skew guard. The activation gate lives half in the deployed backend and
// half in the PUBLISHED CLI: the backend parks a deploy only on the integration
// requirements the CLI puts on the wire. When the CLI's manifest-shape code changes
// but the published CLI is not re-released, `npx two80 push` sends the old (empty)
// shape and the gate has nothing to park on — an unbound app goes Live and 500s
// (root cause of the two80@0.4.6 skew). This fails CI when the files defining what
// the CLI puts on the wire changed since the last published `cli-v*` tag without a
// CLI version bump, forcing a release so the two halves can never ship apart.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Files that determine what the CLI serializes into the wire manifest the backend
// gate trusts verbatim. Add a file here whenever new manifest-shape logic lands.
const SHAPE_FILES = ['packages/cli/src/bundle/manifest280.ts', 'packages/cli/src/bundle/container.ts'];

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

const tags = git('tag', '-l', 'cli-v*')
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
  .sort((a, b) => a.replace('cli-v', '').localeCompare(b.replace('cli-v', ''), undefined, { numeric: true }));

if (tags.length === 0) {
  console.log('manifest-shape-bump: no cli-v* tag yet; nothing published, skipping.');
  process.exit(0);
}

const lastTag = tags[tags.length - 1];
const publishedVersion = lastTag.replace('cli-v', '');
const currentVersion = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8')).version;

const changed = git('diff', '--name-only', `${lastTag}..HEAD`, '--', ...SHAPE_FILES)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

if (changed.length === 0) {
  console.log(`manifest-shape-bump: no wire-shape changes since ${lastTag}; ok.`);
  process.exit(0);
}

if (currentVersion === publishedVersion) {
  console.error(
    `manifest-shape-bump: CLI wire-shape files changed since ${lastTag} but packages/cli/package.json ` +
      `is still ${currentVersion}.\n  changed: ${changed.join(', ')}\n` +
      `  Bump the CLI version so a release ships the new manifest shape; the deployed backend gate ` +
      `depends on the published CLI emitting it (see scripts/check-manifest-shape-bump.mjs).`,
  );
  process.exit(1);
}

console.log(`manifest-shape-bump: wire-shape changed since ${lastTag}; version bumped ${publishedVersion} -> ${currentVersion}; ok.`);
