import Link from "next/link";
import { redirect } from "next/navigation";

import { SignInCard } from "@/components/sign-in-card";
import { SiteHeader } from "@/components/site-header";
import { apiFetch } from "@/lib/api";
import { cookieHeader, getMe, loginHref } from "@/lib/session";

// The browser half of the device flow. The agent never comes here; a human
// does, once, to vouch for the machine their agent is running on.
//
// Approval is relayed to the backend, which owns both the session that proves
// who is approving and the token being minted. This app carries the browser's
// cookie through and names no subject of its own.

// approve runs as a POST reachable by anyone who can forge the request, so it
// re-checks the session itself. Rendering the form behind a signed-in page is
// not a security boundary.
async function approve(formData: FormData) {
  "use server";

  const code = String(formData.get("code") ?? "").trim();
  const me = await getMe();
  if (!me) {
    redirect(loginHref(code ? `/activate?code=${encodeURIComponent(code)}` : "/activate"));
  }
  if (!code) {
    redirect("/activate?error=invalid");
  }

  const res = await apiFetch(`/internal/device/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: await cookieHeader(),
    },
    body: JSON.stringify({ userCode: code }),
    cache: "no-store",
  });

  // redirect() throws to navigate, so it stays outside any try/catch.
  redirect(res.status === 204 ? "/activate?done=1" : "/activate?error=invalid");
}

const MESSAGES: Record<string, string> = {
  invalid: "That code is not valid or has expired. Ask your agent for a new one.",
};

const CARD =
  "w-full max-w-sm rounded-2xl border border-[var(--color-line)] bg-[var(--color-paper)] px-8 py-10 text-center shadow-[0_1px_2px_rgba(10,10,10,0.04)]";

export default async function Activate({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; done?: string; error?: string }>;
}) {
  const { code, done, error } = await searchParams;
  const me = await getMe();

  return (
    <div className="relative flex flex-1 flex-col">
      <div
        aria-hidden
        className="gold-breathe pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(90%_100%_at_50%_0%,rgba(212,175,55,0.13),rgba(212,175,55,0)_62%)]"
      />

      <SiteHeader />

      <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-16">
        {done ? (
          <div className={CARD}>
            <h1 className="font-display text-[2rem] leading-tight text-[var(--color-ink)]">
              Connected
            </h1>
            <p className="mt-3 text-[14px] leading-[1.6] text-[var(--color-body)]">
              Return to your agent. It will pick up from here.
            </p>
            <Link
              href="/dashboard"
              className="mt-7 block w-full rounded-lg bg-[var(--color-ink)] px-4 py-3 text-[14px] font-medium text-[var(--color-paper)] transition-opacity hover:opacity-90"
            >
              Go to dashboard
            </Link>
          </div>
        ) : !me ? (
          <SignInCard
            href={loginHref(code ? `/activate?code=${encodeURIComponent(code)}` : "/activate")}
            heading="Connect your agent"
            subheading="Sign in first."
          />
        ) : (
          <div className={CARD}>
            <h1 className="font-display text-[2rem] leading-tight text-[var(--color-ink)]">
              Connect your agent
            </h1>
            <p className="mt-3 text-[14px] leading-[1.6] text-[var(--color-body)]">
              Enter the code your agent showed you.
            </p>

            <form action={approve} className="mt-7">
              <input
                name="code"
                defaultValue={code ?? ""}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                aria-label="Activation code"
                className="w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-3 text-center font-mono text-[16px] uppercase tracking-[0.2em] text-[var(--color-ink)] outline-none focus:border-[var(--color-gold-500)]"
              />
              <button
                type="submit"
                className="mt-3 w-full rounded-lg bg-[var(--color-ink)] px-4 py-3 text-[14px] font-medium text-[var(--color-paper)] transition-opacity hover:opacity-90"
              >
                Approve
              </button>
            </form>

            {error ? (
              <p className="mt-4 text-[13px] leading-[1.6] text-[#b4342b]">
                {MESSAGES[error] ?? MESSAGES.invalid}
              </p>
            ) : null}

            <p className="mt-6 text-[13px] text-[var(--color-muted)]">
              Signed in as {me.email}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
