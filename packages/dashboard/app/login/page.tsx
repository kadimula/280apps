import { redirect } from "next/navigation";

import { SignInCard } from "@/components/sign-in-card";
import { SiteHeader } from "@/components/site-header";
import { getMe } from "@/lib/session";

// A bare path only: a "next" that leaves the site is an open redirect, and the
// backend rejects one anyway, so this never sends one on.
function safeNext(raw?: string): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  // Already signed in: the dashboard is what they came for, not this page.
  if (await getMe()) {
    redirect("/dashboard");
  }

  return (
    <div className="relative flex flex-1 flex-col">
      <div
        aria-hidden
        className="gold-breathe pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(90%_100%_at_50%_0%,rgba(212,175,55,0.13),rgba(212,175,55,0)_62%)]"
      />

      <SiteHeader>
        <a href="/docs" className="transition-colors hover:text-[var(--color-ink)]">
          Docs
        </a>
      </SiteHeader>

      <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-16">
        <SignInCard redirect={safeNext(next)} error={error} />
      </main>

      <footer className="relative z-10 border-t border-[var(--color-line)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-8 text-[13px] text-[var(--color-muted)]">
          <span className="font-display text-lg font-semibold leading-none text-[var(--color-ink)]">
            280
          </span>
        </div>
      </footer>
    </div>
  );
}
