import Link from "next/link";
import { redirect } from "next/navigation";

import { SiteHeader } from "@/components/site-header";
import { UserMenu } from "@/components/user-menu";
import { getApps } from "@/lib/apps";
import { getMe, logoutHref } from "@/lib/session";

// What a signed-in human sees. The agent pushes, renames, and shares; a human
// comes here to find an app and open it. The list is only names: everything you
// do to an app — its link, sharing, deleting — lives on the app's own page, one
// click away, so the list stays a list.
//
// Apps live in the backend's store, not this app's database, so the list is a
// call to the backend carrying the browser's session, the same seam /activate
// uses.

// UTC keeps the rendered time stable regardless of where the server runs, and
// matches the epoch-seconds the backend stores.
const timeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

function whenText(seconds: number): string {
  return timeFormat.format(new Date(seconds * 1000)) + " UTC";
}

export default async function Dashboard() {
  const user = await getMe();
  if (!user) {
    redirect("/login");
  }

  const apps = await getApps();

  return (
    <div className="relative flex flex-1 flex-col">
      {/* Above main, not level with it. The user menu opens downward into main's
          box, and main is transparent, so a menu that loses the stacking order
          still looks right while main quietly swallows every click on it. */}
      <SiteHeader className="z-20">
        <a href="/docs" className="transition-colors hover:text-[var(--color-ink)]">
          Docs
        </a>
        <UserMenu
          name={user.name}
          email={user.email}
          image={user.image}
          logoutHref={logoutHref()}
        />
      </SiteHeader>

      <main className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-6 pb-24 pt-6">
        <h1 className="font-display text-[2.5rem] leading-tight text-[var(--color-ink)]">
          Your apps
        </h1>

        {apps === null ? (
          <p className="mt-8 text-[14px] text-[var(--color-body)]">
            Could not reach the platform. Try again shortly.
          </p>
        ) : apps.length === 0 ? (
          <div className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper-warm)] px-7 py-9">
            <p className="text-[15px] text-[var(--color-ink)]">Nothing here yet.</p>
            <p className="mt-2 text-[14px] leading-[1.65] text-[var(--color-body)]">
              Tell your agent to push, then reload.
            </p>
            <code className="mt-5 block w-fit rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-2.5 font-mono text-[13px] text-[var(--color-ink)]">
              Fetch 280apps.com/setup.md and push
            </code>
          </div>
        ) : (
          <ul className="mt-8 grid gap-px rounded-xl border border-[var(--color-line)] bg-[var(--color-line)]">
            {apps.map((app) => (
              <li key={app.id} className="first:rounded-t-[11px] last:rounded-b-[11px]">
                {/* The whole row is one link — a name and the way into it. With
                    nothing interactive inside, it can be a plain <a> rather than
                    a stretched overlay. */}
                <Link
                  href={`/dashboard/${app.id}`}
                  className="group flex items-center justify-between gap-6 rounded-[inherit] bg-[var(--color-paper)] px-7 py-5 transition-colors hover:bg-[var(--color-paper-warm)]"
                >
                  <span className="min-w-0 truncate font-sans text-[1.0625rem] font-semibold leading-tight tracking-tight text-[var(--color-ink)]">
                    {app.slug}
                  </span>
                  <div className="flex shrink-0 items-center gap-5">
                    <dl className="hidden grid-cols-[auto_auto] items-baseline gap-x-3 gap-y-1 sm:grid">
                      <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                        Created
                      </dt>
                      <dd className="text-right text-[12.5px] leading-tight text-[var(--color-body)]">
                        {whenText(app.createdAt)}
                      </dd>
                      <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                        Deployed
                      </dt>
                      <dd className="text-right text-[12.5px] leading-tight text-[var(--color-body)]">
                        {app.lastDeployAt === null
                          ? "Not yet"
                          : whenText(app.lastDeployAt)}
                      </dd>
                    </dl>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      className="h-4 w-4 shrink-0 text-[var(--color-muted)] transition-colors group-hover:text-[var(--color-ink)]"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
