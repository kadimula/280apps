export type Action = 'installed' | 'repaired' | 'unchanged' | 'skipped';
export interface InstallResult {
  target: string; // "claude" | "codex" | "opencode" | "skill"
  action: Action;
  path: string; // project-relative path that was written (or would be)
}
