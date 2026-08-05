"use client";

import { useTransition } from "react";

import { setMockAuthAction } from "@/app/dashboard/actions";

// Dev-only, mock-mode only. A one-click flip between the mock's signed-in user
// and a signed-out browser, so the landing and sign-in pages can be iterated
// without editing MOCK_USER or restarting. The server wrapper renders it only
// when the mock backend is on, so it never ships to the deployed site.
export function MockAuthToggle({ signedIn }: { signedIn: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      onClick={() => startTransition(() => setMockAuthAction(!signedIn))}
      disabled={pending}
      title="Mock auth: flip signed in / signed out"
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-2.5 py-1 text-[12px] font-medium leading-none text-[var(--color-body)] shadow-[0_6px_20px_-8px_rgba(10,10,10,0.45)] transition-colors hover:border-[var(--color-gold-400)] disabled:opacity-60"
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          signedIn ? "bg-emerald-500" : "bg-[var(--color-muted)]"
        }`}
      />
      {signedIn ? "Mock: signed in" : "Mock: signed out"}
    </button>
  );
}
