"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

// The app page's "View as" control: the owner previews their app as someone
// else without leaving the dashboard. Selecting an entry rewrites the page's
// ?as= param; the server re-renders, mints a preview grant for that target, and
// the iframe reloads as that identity. The entries come from the same grant
// list the Share dialog shows, so the two surfaces always name the same people.
//
// The component itself holds no identity logic: the page hands it pre-encoded
// param values and labels, and the backend decides what each target may see.

export type ViewAsEntry = {
  // The ?as= param value, or null for the owner's own view (param removed).
  value: string | null;
  label: string;
};

export type ViewAsGroup = {
  title: string;
  entries: ViewAsEntry[];
};

export function ViewAsMenu({
  groups,
  selected,
}: {
  groups: ViewAsGroup[];
  selected: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const pathname = usePathname();
  const root = useRef<HTMLDivElement>(null);

  // A menu that survives a click elsewhere reads as a stuck page.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(value: string | null) {
    setOpen(false);
    if (value === selected) return;
    startTransition(() => {
      router.replace(value ? `${pathname}?as=${encodeURIComponent(value)}` : pathname, {
        scroll: false,
      });
    });
  }

  const active = groups
    .flatMap((group) => group.entries)
    .find((entry) => entry.value === selected);
  const viewing = selected !== null && active !== undefined;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex max-w-[280px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-semibold transition-[color,border-color,opacity] ${
          viewing
            ? "border-[var(--color-gold-400)] bg-[var(--color-paper-warm)] text-[var(--color-ink)] hover:border-[var(--color-gold-500)]"
            : "border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] text-[var(--color-ink)] hover:border-[var(--color-ink)]"
        } ${pending ? "opacity-60" : ""}`}
      >
        <EyeIcon
          className={`h-[15px] w-[15px] shrink-0 ${viewing ? "text-[var(--color-gold-500)]" : ""}`}
        />
        <span className="shrink-0 font-normal text-[var(--color-muted)]">View as</span>
        <span className="min-w-0 truncate">{active?.label ?? "…"}</span>
        <ChevronIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-30 max-h-[min(420px,70vh)] w-64 overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-1.5 shadow-[0_18px_50px_-24px_rgba(10,10,10,0.55)]"
        >
          {groups.map((group, index) => (
            <div key={group.title}>
              {index > 0 && <div className="my-1 h-px bg-[var(--color-line)]" />}
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                {group.title}
              </p>
              {group.entries.map((entry) => {
                const isActive = entry.value === selected;
                return (
                  <button
                    key={entry.value ?? "owner"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => choose(entry.value)}
                    className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-[var(--color-paper-warm)] ${
                      isActive
                        ? "font-semibold text-[var(--color-ink)]"
                        : "text-[var(--color-body)]"
                    }`}
                  >
                    <span className="w-[15px] shrink-0 text-[var(--color-gold-500)]">
                      {isActive ? <CheckIcon /> : null}
                    </span>
                    <span className="min-w-0 truncate">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* icons */

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[15px] w-[15px]">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}
