import Link from "next/link";
import type { ReactNode } from "react";

import { CloverMark } from "@/components/clover-mark";

// The shared site header: the 280 clover lockup on the left and an optional nav
// on the right. Every page renders this one element, so the logo, its size, and
// the spacing stay identical everywhere; pages supply only their nav.
//
// The left region is a slot. By default it's the 280 lockup that links home; a
// page that owns a place of its own — an app's page — passes `brand` to put its
// own lockup there instead (a back arrow, the app's name, its live link).
//
// It runs edge-to-edge: the lockup sits in the screen's top-left corner and the
// nav in the top-right, on every page. Page bodies own their own centering.
export function SiteHeader({
  brand,
  children,
  className,
}: {
  brand?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`relative z-10 flex w-full items-center justify-between gap-4 px-4 py-7 sm:px-5${className ? ` ${className}` : ""}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {brand ?? (
          <Link
            href="/"
            className="flex items-center gap-1.5 font-display text-3xl font-bold leading-none tracking-tight text-[var(--color-ink)]"
          >
            <CloverMark className="h-[0.79em] w-[0.79em] -translate-y-[2px] text-[var(--color-gold-500)]" />
            280
          </Link>
        )}
      </div>
      {children ? (
        <nav className="flex shrink-0 items-center gap-7 text-[13px] text-[var(--color-muted)]">
          {children}
        </nav>
      ) : null}
    </header>
  );
}
