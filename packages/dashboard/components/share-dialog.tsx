"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  type AccessInfo,
  type AppAccess,
  type Grant,
  grantView,
  listViewGrants,
  revokeView,
  setAppAccess,
} from "@/lib/grants";

// The per-app Share control: the second thing an owner does after their agent
// pushes. It borrows the shape people already know from Google Docs, invite by
// email and a list of who can open the link, so nobody has to learn what
// "sharing" means on 280.
//
// Sharing is binary for now: a person can view the app or they can't. Adding an
// email writes a viewer grant on the platform, removing revokes it, and that
// grant is exactly what the gateway checks before admitting someone to the app
// URL. The list always reflects the platform: it loads when the dialog opens
// and reloads after every change.
//
// General access sits below that list and answers the other half of the
// question: who may open the app without a grant at all. It writes the
// dashboard override, which wins over 280.json on every future deploy.

// The general-access popover's key in the one-popover-at-a-time state. Person
// rows key by principal, which is always an email, so this can't collide.
const ACCESS_MENU = "general-access";

function accessLabel(access: AppAccess, tenant: string): string {
  if (access === "public") return "Anyone with the link";
  if (access === "anyone-at-tenant") return `Anyone at ${tenant}`;
  return "Restricted";
}

function accessHint(access: AppAccess, tenant: string): string {
  if (access === "public")
    return "Anyone on the internet with the link can open the app, no sign-in.";
  if (access === "anyone-at-tenant")
    return `Anyone at ${tenant} signed in to 280 can open the app.`;
  return "Only people with access can sign in and open the app.";
}

// A shared link is only meaningful once an app is live, so the row shows Share
// only then and this component can assume it has a real URL to hand out.
export function ShareDialog({
  app,
  owner,
}: {
  app: { id: string; slug: string; url: string };
  owner: { name?: string | null; email?: string | null; image?: string | null };
}) {
  const [open, setOpen] = useState(false);
  // The platform's grant rows, null while the first load is in flight. The
  // rendered list is derived from this, so it can only show what is persisted.
  const [grants, setGrants] = useState<Grant[] | null>(null);
  // The general-access mode and the facts that shape its menu, from the same
  // load as the grants. Null until the first load lands.
  const [access, setAccess] = useState<AccessInfo | null>(null);
  // Which popover is open, if any: a person's principal, or ACCESS_MENU for the
  // general-access dial. One at a time.
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [broken, setBroken] = useState(false);
  const [draft, setDraft] = useState("");

  const modal = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const headingId = useId();

  const refresh = useCallback(async () => {
    const result = await listViewGrants(app.id);
    if ("error" in result) {
      setError(result.error);
      setGrants((was) => was ?? []);
    } else {
      setGrants(result.grants);
      setAccess({
        access: result.access,
        accessSource: result.accessSource,
        ownerTenant: result.ownerTenant,
        ownerTenantIsConsumer: result.ownerTenantIsConsumer,
      });
    }
  }, [app.id]);

  // Opening kicks off the list load right in the click handler, so the fetch
  // starts once per open rather than riding an effect that other state changes
  // would retrigger.
  function openDialog() {
    setOpen(true);
    refresh();
  }

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape peels one layer: an open popover first, then the dialog.
      if (menu) setMenu(null);
      else close();
    };
    // A click anywhere but an open popover dismisses just the popover. The
    // scrim handles dismissing the dialog itself.
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element)?.closest("[data-menu]")) setMenu(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, menu, refresh]);

  function close() {
    setOpen(false);
    setMenu(null);
    setCopied(false);
    setError(null);
    setGrants(null);
    setAccess(null);
    setDraft("");
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const email = draft.trim().toLowerCase();
    if (!email || busy) return;
    if (people.some((p) => p.principal === email)) {
      setDraft("");
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await grantView(app.id, email);
    if (failure) {
      setError(failure.error);
    } else {
      setDraft("");
      await refresh();
    }
    setBusy(false);
    field.current?.focus();
  }

  async function remove(principal: string) {
    setMenu(null);
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await revokeView(app.id, principal);
    if (failure) setError(failure.error);
    else await refresh();
    setBusy(false);
  }

  // Picking a mode writes it immediately and optimistically: the row is the
  // control's own label, so waiting on the round-trip would leave the menu
  // showing the old answer. A refusal puts the platform's truth back.
  async function changeAccess(next: AppAccess) {
    setMenu(null);
    if (busy || !access || next === access.access) return;
    setBusy(true);
    setError(null);
    setAccess({ ...access, access: next, accessSource: "dashboard" });
    const failure = await setAppAccess(app.id, next);
    if (failure) {
      setError(failure.error);
      setAccess(access);
    } else {
      await refresh();
    }
    setBusy(false);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(app.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be blocked; the link is on screen regardless.
    }
  }

  const ownerLabel = owner.name || owner.email || "You";
  const ownerInitial = ownerLabel.trim().charAt(0).toUpperCase();

  // Everyone with access besides the owner. Any grant admits its principal to
  // the app, so within the binary model every row reads simply "Can view".
  // Domain-wide grants (principal "domain:...") have no row style here yet and
  // are left to the surface that can explain them.
  const people = (grants ?? []).filter(
    (g) => g.appRole !== "owner" && g.principal.includes("@"),
  );
  const loading = grants === null;
  // Fail closed while the first load is in flight: the strictest mode is the
  // safest thing to claim about an app we haven't heard back about.
  const current: AppAccess = access?.access ?? "invited";
  const tenant = access?.ownerTenant || "your organization";

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]"
      >
        <ShareIcon />
        Share
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(10,10,10,0.34)] px-6 py-[68px] backdrop-blur-[1px]"
            onClick={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              ref={modal}
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              className="w-full max-w-[468px] rounded-[18px] border border-[var(--color-line)] bg-[var(--color-paper)] px-6 pb-5 pt-6 shadow-[0_24px_70px_-18px_rgba(10,10,10,0.55)]"
            >
              <div className="flex items-center justify-between gap-3">
                <h2
                  id={headingId}
                  className="min-w-0 truncate font-display text-[1.5rem] leading-tight tracking-tight text-[var(--color-ink)]"
                >
                  Share{" "}
                  <span className="text-[var(--color-muted)]">
                    &ldquo;{app.slug}&rdquo;
                  </span>
                </h2>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="shrink-0 cursor-pointer rounded-lg p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]"
                >
                  <CloseIcon />
                </button>
              </div>

              <form onSubmit={invite} className="mt-[18px]">
                <input
                  ref={field}
                  type="email"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError(null);
                  }}
                  placeholder="Add people by email"
                  autoComplete="off"
                  disabled={busy}
                  className="w-full rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-3 text-[14.5px] text-[var(--color-ink)] outline-none transition-colors placeholder:text-[var(--color-muted)] focus:border-[var(--color-link)] disabled:opacity-60"
                />
              </form>
              {error && (
                <p role="alert" className="mt-2 px-1 text-[13px] text-[#b4342b]">
                  {error}
                </p>
              )}

              <div className="mt-5 flex items-center justify-between">
                <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">
                  People with access
                </h3>
                <div className="flex gap-0.5">
                  <IconButton label="Copy list" onClick={copyLink}>
                    <CopyIcon />
                  </IconButton>
                  <IconButton label="Email link" onClick={copyLink}>
                    <MailIcon />
                  </IconButton>
                </div>
              </div>

              <div className="mt-1.5">
                <div className="flex items-center gap-3 py-2">
                  <span className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)]">
                    {owner.image && !broken ? (
                      <Image
                        src={owner.image}
                        alt=""
                        width={72}
                        height={72}
                        className="h-full w-full object-cover"
                        onError={() => setBroken(true)}
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[13px] font-medium text-[var(--color-body)]">
                        {ownerInitial}
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] font-medium text-[var(--color-ink)]">
                      {owner.name ? `${owner.name} (you)` : "You"}
                    </p>
                    {owner.email && (
                      <p className="truncate font-mono text-[13px] text-[var(--color-muted)]">
                        {owner.email}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-[14px] text-[var(--color-muted)]">
                    Owner
                  </span>
                </div>

                {people.map((person) => (
                  <div
                    key={person.principal}
                    className="flex items-center gap-3 py-2"
                  >
                    {/* The cream chip keeps its light fill in both themes, so its
                        initial needs a fixed dark ink rather than the theme's. */}
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-gold-50)] text-[13px] font-semibold text-[#4a4636]">
                      {person.principal.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[14px] text-[var(--color-ink)]">
                        {person.principal}
                      </p>
                    </div>
                    <div className="relative shrink-0" data-menu>
                      <button
                        type="button"
                        onClick={() =>
                          setMenu((m) =>
                            m === person.principal ? null : person.principal,
                          )
                        }
                        className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[14px] text-[var(--color-body)] transition-colors hover:bg-[var(--color-paper-warm)]"
                      >
                        Can view
                        <ChevronIcon />
                      </button>
                      {menu === person.principal && (
                        <div className="absolute right-0 top-[calc(100%+4px)] z-10 min-w-[176px] rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-1.5 shadow-[0_18px_50px_-24px_rgba(10,10,10,0.55)]">
                          <MenuItem active onClick={() => setMenu(null)}>
                            Can view
                          </MenuItem>
                          <div className="my-1 h-px bg-[var(--color-line)]" />
                          <MenuItem
                            danger
                            onClick={() => remove(person.principal)}
                          >
                            Remove access
                          </MenuItem>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {loading && (
                  <p className="py-2 pl-12 text-[13px] text-[var(--color-muted)]">
                    Loading&hellip;
                  </p>
                )}
                {!loading && people.length === 0 && (
                  <p className="py-2 pl-12 text-[13px] text-[var(--color-muted)]">
                    No one else has access yet. People you add can view the app.
                  </p>
                )}
              </div>

              <div className="mt-5 border-t border-[var(--color-line)] pt-4">
                <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">
                  General access
                </h3>
                <div className="mt-1.5 flex items-center gap-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-line-strong)] ${
                      current === "public"
                        ? "bg-[var(--color-gold-50)] text-[#4a4636]"
                        : "bg-[var(--color-paper-warm)] text-[var(--color-body)]"
                    }`}
                  >
                    {current === "invited" ? <LockIcon /> : <GlobeIcon />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="relative inline-block" data-menu>
                      <button
                        type="button"
                        disabled={!access || busy}
                        onClick={() =>
                          setMenu((m) => (m === ACCESS_MENU ? null : ACCESS_MENU))
                        }
                        className="-ml-2 flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[14.5px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-paper-warm)] disabled:cursor-default disabled:opacity-60"
                      >
                        {access ? accessLabel(current, tenant) : "Loading…"}
                        <ChevronIcon />
                      </button>
                      {menu === ACCESS_MENU && access && (
                        <div className="absolute left-0 top-[calc(100%+4px)] z-10 min-w-[248px] rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-1.5 shadow-[0_18px_50px_-24px_rgba(10,10,10,0.55)]">
                          <MenuItem
                            active={current === "invited"}
                            onClick={() => changeAccess("invited")}
                          >
                            {accessLabel("invited", tenant)}
                          </MenuItem>
                          {/* An owner on gmail.com has no org, so "anyone at
                              gmail.com" is not a tenant the gateway will admit
                              on; the option stays visible but inert. */}
                          <MenuItem
                            active={current === "anyone-at-tenant"}
                            disabled={access.ownerTenantIsConsumer}
                            onClick={() => changeAccess("anyone-at-tenant")}
                          >
                            {accessLabel("anyone-at-tenant", tenant)}
                          </MenuItem>
                          <MenuItem
                            active={current === "public"}
                            onClick={() => changeAccess("public")}
                          >
                            {accessLabel("public", tenant)}
                          </MenuItem>
                        </div>
                      )}
                    </div>
                    <p className="px-0 text-[13px] text-[var(--color-muted)]">
                      {access ? accessHint(current, tenant) : " "}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <button
                  type="button"
                  onClick={copyLink}
                  className="flex cursor-pointer items-center gap-2 rounded-full border border-[var(--color-line-strong)] px-[18px] py-2.5 text-[14px] font-semibold text-[var(--color-link)] transition-colors hover:border-[var(--color-link)]"
                >
                  <LinkIcon />
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="cursor-pointer rounded-full bg-[var(--color-ink)] px-7 py-2.5 text-[14px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90"
                >
                  Done
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="cursor-pointer rounded-lg p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]"
    >
      {children}
    </button>
  );
}

function MenuItem({
  active,
  danger,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-[var(--color-paper-warm)] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent ${
        danger
          ? "text-[#b4342b]"
          : active
            ? "font-semibold text-[var(--color-ink)]"
            : "text-[var(--color-body)]"
      }`}
    >
      <span className="w-[15px] text-[var(--color-gold-500)]">
        {active && !danger ? <CheckIcon /> : null}
      </span>
      {children}
    </button>
  );
}

/* icons */

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[15px] w-[15px]">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="h-[18px] w-[18px]">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden className="h-[17px] w-[17px]">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden className="h-[17px] w-[17px]">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden className="h-3.5 w-3.5 text-[var(--color-muted)]">
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

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[17px] w-[17px]">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[17px] w-[17px]">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17Z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[15px] w-[15px]">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}
