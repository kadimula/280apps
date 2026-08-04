"use client";

import { useEffect, useState } from "react";

// The entry prompt an agent pastes to get started. The setup URL is derived from
// the backend (TWO80_API) by the server that renders this, so no host is baked
// in here.
export function InstallCommand({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="w-full">
      <div className="group relative overflow-hidden border border-[var(--color-terminal-line)] bg-[var(--color-terminal)] shadow-[0_18px_50px_-24px_rgba(10,10,10,0.55)]">
        <p className="px-5 pt-3 text-left font-semibold text-[13px] leading-6 text-[#b6b6b6] sm:px-6">
          <i>Paste into Claude Code, Cursor, Codex, or your agent of choice.</i>
        </p>

        <div className="mt-2 h-px bg-white/10" />

        <div className="flex items-center gap-4 px-5 py-5 sm:px-6">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left font-mono text-[13px] leading-6 text-[var(--color-gold-200)] sm:text-sm">
            {prompt}
          </code>

          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-md border border-white/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-gold-200)] transition-colors hover:border-[var(--color-gold-400)] hover:text-[#f3e8c8]"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
