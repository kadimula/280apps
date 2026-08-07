"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";

import { deleteAppAction } from "@/app/dashboard/actions";

// The per-app control, living on the app's own page. For now it holds the one
// action that takes something away.
//
// Deleting asks the human to type "delete". The dialog already names the app,
// which is the part `two80 delete --yes <name>` has to get from a command line.
// The button unlocking is a courtesy; the platform checks the word regardless.

const CONFIRM_WORD = "delete";

function Dots() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="h-4 w-4">
      <circle cx="8" cy="3" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="8" cy="13" r="1.4" />
    </svg>
  );
}

export function AppMenu({ appId, slug }: { appId: string; slug: string }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const headingId = useId();

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

  // Escape leaves the dialog, except mid-delete: the request is already gone,
  // and closing over it would hide whether it worked.
  useEffect(() => {
    if (!confirming) return;
    field.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirming, pending]);

  function close() {
    setConfirming(false);
    setTyped("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await deleteAppAction(appId, typed);
      // The app this page was about is gone; there is nothing left to show, so
      // return to the list (which the action has already revalidated).
      if (result?.error) setError(result.error);
      else router.push("/dashboard");
    });
  }

  const armed = typed.trim().toLowerCase() === CONFIRM_WORD;

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${slug}`}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]"
      >
        <Dots />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-30 w-44 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[0_18px_50px_-24px_rgba(10,10,10,0.55)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setConfirming(true);
            }}
            className="w-full cursor-pointer px-4 py-3 text-left text-[13px] text-[#b4342b] transition-colors hover:bg-[var(--color-paper-warm)]"
          >
            Delete app
          </button>
        </div>
      )}

      {/* Portalled: the dashboard's header outranks main in the stacking
          order, so an overlay rendered in place would sit under it. */}
      {confirming &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,10,10,0.32)] px-6"
            onClick={(event) => {
              if (event.target === event.currentTarget && !pending) close();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              className="w-full max-w-sm rounded-2xl border border-[var(--color-line)] bg-[var(--color-paper)] px-7 py-7 shadow-[0_24px_70px_-30px_rgba(10,10,10,0.6)]"
            >
              <h2
                id={headingId}
                className="font-sans text-[1.15rem] font-semibold leading-tight tracking-tight text-[var(--color-ink)]"
              >
                Delete {slug}?
              </h2>
              <p className="mt-2 text-[14px] leading-[1.6] text-[var(--color-body)]">
                The app, its URL, and its data are gone for good.
              </p>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <label
                  htmlFor={`${headingId}-name`}
                  className="mt-6 block text-[13px] text-[var(--color-muted)]"
                >
                  Type <span className="font-mono text-[var(--color-ink)]">{CONFIRM_WORD}</span>{" "}
                  to confirm
                </label>
                <input
                  id={`${headingId}-name`}
                  ref={field}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  className="mt-2 w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-2.5 font-mono text-[14px] text-[var(--color-ink)] outline-none focus:border-[var(--color-gold-500)]"
                />

                {error && (
                  <p className="mt-3 text-[13px] leading-[1.5] text-[#b4342b]">{error}</p>
                )}

                <div className="mt-6 flex gap-3">
                  <button
                    type="button"
                    onClick={close}
                    disabled={pending}
                    className="flex-1 cursor-pointer rounded-lg border border-[var(--color-line-strong)] px-4 py-2.5 text-[14px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-paper-warm)] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!armed || pending}
                    className="flex-1 cursor-pointer rounded-lg bg-[#b4342b] px-4 py-2.5 text-[14px] font-medium text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pending ? "Deleting" : "Delete"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
