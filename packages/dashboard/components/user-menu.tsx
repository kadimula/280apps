"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

// Identity and the way out, in one control. The avatar comes from Google when
// the account has one; without a picture the initial stands in rather than a
// placeholder face. Sign-out posts to the backend, which clears the session
// cookie and sends the browser home, so this app holds no logout logic.

export function UserMenu({
  name,
  email,
  image,
  logoutHref,
}: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  logoutHref: string;
}) {
  const [open, setOpen] = useState(false);
  // Google's CDN can 404 a stale avatar, and the optimizer answers 400 for a
  // host that is not allowed. Both land here, and both fall back to the initial
  // rather than a broken image icon.
  const [broken, setBroken] = useState(false);
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

  const label = name || email || "Account";
  const initial = label.trim().charAt(0).toUpperCase();

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="block h-8 w-8 cursor-pointer overflow-hidden rounded-full border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] transition-colors hover:border-[var(--color-gold-400)]"
      >
        {image && !broken ? (
          <Image
            src={image}
            alt=""
            width={64}
            height={64}
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center font-medium text-[13px] text-[var(--color-body)]">
            {initial}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-20 w-56 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[0_18px_50px_-24px_rgba(10,10,10,0.55)]"
        >
          {(name || email) && (
            <div className="border-b border-[var(--color-line)] px-4 py-3">
              {name && (
                <p className="truncate text-[13px] text-[var(--color-ink)]">
                  {name}
                </p>
              )}
              {email && (
                <p className="truncate text-[12px] text-[var(--color-muted)]">
                  {email}
                </p>
              )}
            </div>
          )}
          <form action={logoutHref} method="post">
            <button
              type="submit"
              role="menuitem"
              className="w-full cursor-pointer px-4 py-3 text-left text-[13px] text-[var(--color-body)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
