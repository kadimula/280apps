// Shared result vocabulary every installer reports back, one value per target.

// `unchanged` is the idempotent re-run; `repaired` is a path fix on reinstall;
// `skipped` means the target agent is absent and was deliberately left alone.
export type Action = 'installed' | 'repaired' | 'unchanged' | 'skipped';

export interface InstallResult {
  target: string; // "claude" | "codex" | "opencode" | "skill"
  action: Action;
  path: string; // project-relative path that was written (or would be)
}
