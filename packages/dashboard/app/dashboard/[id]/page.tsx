import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppMenu } from "@/components/app-menu";
import { CloverMark } from "@/components/clover-mark";
import { ShareDialog } from "@/components/share-dialog";
import { SiteHeader } from "@/components/site-header";
import { UserMenu } from "@/components/user-menu";
import { VariablesDialog } from "@/components/variables-dialog";
import {
  type ViewAsGroup,
  ViewAsMenu,
} from "@/components/view-as-menu";
import { getApp } from "@/lib/apps";
import { listViewGrants } from "@/lib/grants";
import { mintPreviewUrl, parseViewAs, VIEW_AS_ROLES } from "@/lib/preview";
import { getMe, logoutHref } from "@/lib/session";

// One app's own page. The site header carries this app's own lockup in place of
// the 280 mark — a way back to the list, the name, and the live link — and, in
// the same nav as Docs and the account, the things an owner does with an app:
// share it, preview it as someone else, and (through the menu) manage it. Below
// it, the app itself fills the rest of the viewport in an iframe.
//
// The iframe never loads the app URL directly: the app is a different site, so
// the owner's dashboard session would not ride along and the frame would show a
// second sign-in. Instead the server mints a preview grant here during render
// (lib/preview) and the iframe loads the gateway's bootstrap URL, which admits
// the owner — or the ?as= target the "View as" menu picked — with no sign-in.

export default async function AppPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ as?: string; variables?: string }>;
}) {
  const user = await getMe();
  if (!user) {
    redirect("/login");
  }

  const [{ id }, { as, variables }] = await Promise.all([params, searchParams]);
  const app = await getApp(id);
  if (!app) {
    notFound();
  }

  const host = app.url.replace(/^https:\/\//, "");
  const viewAs = parseViewAs(as);

  // The grant list feeds the "View as" menu; a refusal (not the owner, platform
  // down) simply hides the menu rather than erroring the page. The preview mint
  // rides the same render: its failure is the fallback panel below.
  const [previewUrl, grantList] = app.live
    ? await Promise.all([mintPreviewUrl(app.id, viewAs), listViewGrants(app.id)])
    : [null, null];

  // The same people the Share dialog lists, so the two surfaces always agree on
  // who the app is shared with. Domain-wide grants have no row here either.
  const viewers =
    grantList && !("error" in grantList)
      ? grantList.grants.filter(
          (g) => g.appRole !== "owner" && g.principal.includes("@"),
        )
      : null;

  const viewAsGroups: ViewAsGroup[] | null = viewers && [
    { title: "You", entries: [{ value: null, label: "Yourself (owner)" }] },
    ...(viewers.length > 0
      ? [
          {
            title: "People",
            entries: viewers.map((g) => ({
              value: `user:${g.principal}`,
              label: g.principal,
            })),
          },
        ]
      : []),
    {
      title: "Roles",
      entries: VIEW_AS_ROLES.map((role) => ({
        value: `role:${role}`,
        label: role.charAt(0).toUpperCase() + role.slice(1),
      })),
    },
  ];

  // The menu's canonical selection, rebuilt from the parsed target so an
  // unrecognized ?as= renders as the owner view it actually minted.
  const selected =
    viewAs.kind === "user"
      ? `user:${viewAs.email}`
      : viewAs.kind === "role"
        ? `role:${viewAs.appRole}`
        : null;

  return (
    <div className="flex h-screen flex-col bg-[var(--color-paper)]">
      <SiteHeader
        className="z-20 border-b border-[var(--color-line)]"
        brand={
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Link
              href="/dashboard"
              aria-label="Your apps"
              className="-my-7 -ml-4 flex shrink-0 items-center gap-2 self-stretch pl-4 pr-3 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)] sm:-ml-5 sm:gap-2.5 sm:pl-5"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4">
                <path d="m15 18-6-6 6-6" />
              </svg>

              <CloverMark className="hidden h-[18px] w-[18px] shrink-0 text-[var(--color-gold-500)] sm:block" />
            </Link>

            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="shrink-0 truncate font-sans text-[15px] font-semibold leading-tight tracking-tight text-[var(--color-ink)]">
                {app.slug}
              </span>
              {app.live ? (
                <a
                  href={app.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hidden min-w-0 truncate font-mono text-[12.5px] text-[var(--color-link)] transition-colors hover:text-[var(--color-link-hover)] md:block"
                >
                  {host}
                </a>
              ) : (
                <span className="hidden shrink-0 font-mono text-[12.5px] text-[var(--color-muted)] md:block">
                  Not deployed
                </span>
              )}
            </div>
          </div>
        }
      >
        {app.live && viewAsGroups && (
          <ViewAsMenu groups={viewAsGroups} selected={selected} />
        )}
        {app.live && (
          <ShareDialog
            app={{ id: app.id, slug: app.slug, url: app.url }}
            owner={{
              name: user.name,
              email: user.email,
              image: user.image,
            }}
          />
        )}
        <VariablesDialog app={{ id: app.id, slug: app.slug }} autoOpen={variables === "1"} />
        <AppMenu appId={app.id} slug={app.slug} />
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

      {!app.live ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="font-display text-[1.75rem] leading-tight text-[var(--color-ink)]">
            Not deployed yet
          </p>
          <p className="max-w-sm text-[14px] leading-[1.65] text-[var(--color-body)]">
            Tell your agent to push{" "}
            <span className="font-mono text-[var(--color-ink)]">{app.slug}</span>, then
            reload to see it here.
          </p>
        </div>
      ) : previewUrl ? (
        // The app, framed as its visitors see it — bootstrapped through the
        // gateway's preview path so it renders signed in. Its own address bar is
        // the toolbar's host link, so the frame itself is chrome-free. Keyed on
        // the bootstrap URL: a new grant (a "View as" change) replaces the
        // frame rather than soft-navigating a stale one.
        <iframe
          key={previewUrl}
          src={previewUrl}
          title={app.slug}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
        />
      ) : (
        // No grant could be minted (platform unreachable, session lapsed, or a
        // browser that drops even partitioned cookies). The app itself is fine,
        // so the honest fallback is its real front door in a new tab, where a
        // top-level visit signs in normally.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="font-display text-[1.75rem] leading-tight text-[var(--color-ink)]">
            Preview unavailable
          </p>
          <p className="max-w-sm text-[14px] leading-[1.65] text-[var(--color-body)]">
            The app could not be embedded here just now. It is still running at
            its own address.
          </p>
          <a
            href={app.url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 flex items-center gap-2 rounded-full bg-[var(--color-ink)] px-[18px] py-2.5 text-[14px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90"
          >
            Open in a new tab
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5">
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </a>
        </div>
      )}
    </div>
  );
}
