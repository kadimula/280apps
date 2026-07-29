// skill generates and installs the 280 Agent Skill — the secondary integration
// (AXI §7) that loads on demand in any skill-aware agent, complementing the
// session hook. It is generated from the home view's static content (the shared
// DESCRIPTION plus the fixed command guidance), with live state stripped so the
// skill never drifts from the CLI's own guidance. Command examples are rewritten
// to `npx -y two80@latest ...` because a skill can be installed without the `280`
// binary on PATH. `280 setup` writes it into the agent's skills dir; `--check`
// (wired into CI) fails when the committed copy is stale.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './jsonfile.js';
import { DESCRIPTION } from '../homeview.js';
import type { InstallResult } from './result.js';

// SKILL_NAME is the skill's directory name and frontmatter `name`.
export const SKILL_NAME = '280-deploy';

// INSTALL_FILE is where `280 setup` writes the skill, project-scoped so it is
// directory-scoped like the hooks (AXI §7). This is the Agent Skills layout a
// skill-aware agent reads.
export const INSTALL_FILE = path.join('.claude', 'skills', SKILL_NAME, 'SKILL.md');

// TRIGGER is the frontmatter description, written as a trigger (AXI §7): terse,
// outcome-focused, so an agent loads the skill on the right intent.
const TRIGGER =
  'Deploy and share a local web app (Next.js or static) to a live URL with one command. ' +
  'Use when the user wants to deploy, publish, ship, or share an app or prototype and get a link.';

// generate renders the full SKILL.md. Deterministic and state-free, so the
// committed file and `--check` compare byte for byte. DESCRIPTION is imported
// from the home view (single source of truth).
export function generate(): string {
  return `---
name: ${SKILL_NAME}
description: ${TRIGGER}
---

# 280: deploy and share

${DESCRIPTION} 280 turns a local app into a live, shareable URL. One verb does
everything: build, upload, and print the link. Run it via \`npx\` so no install
is needed.

## Deploy

\`\`\`sh
npx -y two80@latest push
\`\`\`

- Runs from the app's directory. Auto-detects Next.js or static; no config needed.
- First push starts a device login: it prints a link and a code, then exits. Give
  the link to the user to approve, then run \`push\` again to finish and deploy.
- Reports the live URL on success. Re-run \`push\` to redeploy.

## Other commands

\`\`\`sh
npx -y two80@latest            # this directory's app state and next steps
npx -y two80@latest whoami     # auth state
npx -y two80@latest login      # authenticate this machine (prints a link)
npx -y two80@latest delete --yes <name>   # destroy the app: URL, content, data
\`\`\`

## Notes

- Output is agent-readable (TOON on stdout). Errors carry a runnable fix.
- Exit codes: 0 ok, 1 failure (with a fix), 2 bad flags or args.
- Ambient state at session start: run \`npx -y two80@latest setup\` once to register
  a hook that shows this directory's app state when a session opens.
`;
}

// install writes the generated skill into the agent's skills dir, idempotently:
// an identical existing file is a no-op.
export function install(root: string): InstallResult {
  const file = path.join(root, INSTALL_FILE);
  const desired = generate();
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (current === desired) return { target: 'skill', action: 'unchanged', path: INSTALL_FILE };
  writeAtomic(file, desired);
  return { target: 'skill', action: current === null ? 'installed' : 'repaired', path: INSTALL_FILE };
}

// committedPath locates the repo's committed SKILL.md (packages/cli/skill/) by
// walking up from this module to the `two80` package root, so `--check` works
// from source (vitest), from the tsup bundle, and from an installed package.
export function committedPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    try {
      const name = JSON.parse(fs.readFileSync(pkg, 'utf8')).name;
      if (name === 'two80') return path.join(dir, 'skill', 'SKILL.md');
    } catch {
      // not the package root; keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate the two80 package root for --check');
    dir = parent;
  }
}

export interface CheckResult {
  fresh: boolean;
  path: string; // committed file path
}

// check compares the committed skill against freshly generated content. fresh is
// false when they differ (the committed copy is stale) or the file is missing.
// The comparison is newline-normalized so a CRLF checkout (git autocrlf on
// Windows CI) is not mistaken for drift — the committed file is canonical LF
// (pinned in .gitattributes), and content, not line endings, is what matters.
export function check(): CheckResult {
  const p = committedPath();
  let committed = '';
  try {
    committed = fs.readFileSync(p, 'utf8');
  } catch {
    return { fresh: false, path: p };
  }
  return { fresh: lf(committed) === lf(generate()), path: p };
}

function lf(s: string): string {
  return s.replace(/\r\n/g, '\n');
}
