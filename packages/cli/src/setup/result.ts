// result is the shared vocabulary every installer reports back in. One value per
// target (each agent's hook, plus the skill), rolled up by the setup command
// into the AXI home-view-style output. Paths are project-relative so the output
// stays directory-scoped and stable across machines.

// Action is what an install call actually did. `unchanged` is the idempotent
// re-run (AXI §7: repeated installs with the same path are silent no-ops);
// `repaired` is a path fix on reinstall; `skipped` means the target agent is not
// present in this directory and was deliberately left alone.
export type Action = 'installed' | 'repaired' | 'unchanged' | 'skipped';

export interface InstallResult {
  target: string; // "claude" | "codex" | "opencode" | "skill"
  action: Action;
  path: string; // project-relative path that was written (or would be)
}
