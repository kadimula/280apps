"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  type AppVariable,
  deleteVariable,
  listVariables,
  revealVariable,
  setVariable,
} from "@/lib/variables";

export function VariablesDialog({ app, autoOpen = false }: { app: { id: string; slug: string }; autoOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const [variables, setVariables] = useState<AppVariable[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const headingId = useId();
  const field = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    const result = await listVariables(app.id);
    if ("error" in result) {
      setError(result.error);
      setVariables((current) => current ?? []);
    } else {
      setVariables(result.variables);
    }
  }, [app.id]);

  function openDialog() {
    setOpen(true);
    refresh();
  }

  // Open from a client-only effect, never from initial state: seeding open from
  // autoOpen would evaluate createPortal(..., document.body) during SSR, where
  // document is undefined, and throw at render time.
  useEffect(() => {
    if (autoOpen) queueMicrotask(() => { setOpen(true); void refresh(); });
  }, [autoOpen, refresh]);

  function close() {
    setOpen(false);
    setVariables(null);
    setEditing(null);
    setMenu(null);
    setRevealed({});
    setValue("");
    setError(null);
  }

  function edit(name: string) {
    setMenu(null);
    setEditing(name);
    setValue("");
    setError(null);
  }

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu) setMenu(null);
      else if (editing) {
        setEditing(null);
        setValue("");
        setError(null);
      } else close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element)?.closest("[data-variable-menu]")) setMenu(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, editing, menu]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !value || busy) return;
    setBusy(editing);
    setError(null);
    const failure = await setVariable(app.id, editing, value);
    if (failure) setError(failure.error);
    else {
      setEditing(null);
      setValue("");
      await refresh();
    }
    setBusy(null);
  }

  async function toggleReveal(name: string) {
    if (revealed[name] !== undefined) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      return;
    }
    setBusy(name);
    setError(null);
    const result = await revealVariable(app.id, name);
    if ("error" in result) setError(result.error);
    else setRevealed((current) => ({ ...current, [name]: result.value }));
    setBusy(null);
  }

  async function remove(name: string) {
    setMenu(null);
    setBusy(name);
    setError(null);
    const failure = await deleteVariable(app.id, name);
    if (failure) setError(failure.error);
    else {
      setRevealed((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      await refresh();
    }
    setBusy(null);
  }

  return (
    <>
      <button type="button" onClick={openDialog} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]">
        <VariablesIcon />
        Variables
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(10,10,10,0.66)] px-6 py-[68px] backdrop-blur-[1px]" onClick={(event) => event.target === event.currentTarget && close()}>
          <div role="dialog" aria-modal="true" aria-labelledby={headingId} className="w-full max-w-[560px] rounded-[18px] border border-[var(--color-line)] bg-[var(--color-paper)] px-6 pb-5 pt-6 shadow-[0_24px_70px_-18px_rgba(10,10,10,0.55)]">
            <div className="flex items-center justify-between gap-3">
              <h2 id={headingId} className="min-w-0 truncate font-sans text-[1.5rem] leading-tight tracking-tight text-[var(--color-ink)]">
                {variables === null ? "Variables" : `${variables.length} ${variables.length === 1 ? "variable" : "variables"} for`} <span className="text-[var(--color-muted)]">&ldquo;{app.slug}&rdquo;</span>
              </h2>
              <button type="button" onClick={close} aria-label="Close variables" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]">
                <CloseIcon />
              </button>
            </div>

            <div className="mt-5 border-t border-[var(--color-line)] pt-2">
              {variables === null && <p className="py-5 text-[13px] text-[var(--color-muted)]">Loading&hellip;</p>}
              {variables?.length === 0 && (
                <div className="py-7 text-center">
                  <p className="text-[14px] font-semibold text-[var(--color-ink)]">No variables declared</p>
                  <p className="mt-1 text-[13px] text-[var(--color-muted)]">Add variable names to 280.json, then push the app again.</p>
                </div>
              )}

              {variables?.map((variable) => (
                <div key={variable.name} className="relative rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--color-paper-warm)]">
                  <div className="flex min-h-9 items-center gap-3">
                    <span className="shrink-0 font-mono text-[13px] text-[var(--color-muted)]">{"{}"}</span>
                    <p className="min-w-0 flex-1 truncate font-mono text-[13.5px] font-medium text-[var(--color-ink)]">{variable.name}</p>
                    {variable.kind === "config" && (
                      <span className="shrink-0 rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]" title="Config: a value the app reads via process.env">config</span>
                    )}

                    {variable.configured ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-[var(--color-body)]">
                          {revealed[variable.name] ?? "••••••••"}
                        </span>
                        <button type="button" onClick={() => toggleReveal(variable.name)} disabled={busy === variable.name} aria-label={revealed[variable.name] === undefined ? `Show ${variable.name}` : `Hide ${variable.name}`} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-50">
                          {revealed[variable.name] === undefined ? <EyeIcon /> : <EyeOffIcon />}
                        </button>
                      </div>
                    ) : (
                      <span className="flex-1 text-[13px] text-[var(--color-muted)]">Not added</span>
                    )}

                    {variable.configured ? (
                      <div className="relative shrink-0" data-variable-menu>
                        <button type="button" onClick={() => setMenu((current) => current === variable.name ? null : variable.name)} aria-label={`Actions for ${variable.name}`} aria-haspopup="menu" aria-expanded={menu === variable.name} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
                          <MoreIcon />
                        </button>
                        {menu === variable.name && (
                          <div role="menu" className="absolute right-0 top-[calc(100%+4px)] z-10 w-[156px] rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-1.5 shadow-[0_18px_50px_-24px_rgba(10,10,10,0.65)]">
                            <button type="button" role="menuitem" onClick={() => edit(variable.name)} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-[var(--color-body)] transition-colors hover:bg-[var(--color-paper-warm)]"><EditIcon />Edit</button>
                            <button type="button" role="menuitem" onClick={() => remove(variable.name)} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-[#b4342b] transition-colors hover:bg-[var(--color-paper-warm)]"><TrashIcon />Delete</button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <button type="button" onClick={() => edit(variable.name)} className="cursor-pointer rounded-lg border border-[var(--color-line-strong)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]">Add</button>
                    )}
                  </div>

                  {editing === variable.name && (
                    <form onSubmit={save} className="mt-3 pl-8">
                      <label className="sr-only" htmlFor={`${headingId}-${variable.name}`}>Value for {variable.name}</label>
                      {/* Textarea, not a single-line input: some credentials are multi-line
                          (a PEM private_key), which a password input makes unreadable to enter.
                          Rows grow with the pasted content and cap with an inner scroll. */}
                      <textarea ref={field} id={`${headingId}-${variable.name}`} value={value} onChange={(event) => { setValue(event.target.value); setError(null); }} placeholder="Enter value" autoComplete="off" spellCheck={false} rows={Math.min(Math.max(value.split("\n").length, 3), 14)} disabled={busy === variable.name} className="w-full resize-y rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-3 font-mono text-[14px] leading-snug text-[var(--color-ink)] outline-none transition-colors placeholder:font-sans placeholder:text-[var(--color-muted)] focus:border-[var(--color-gold-500)] disabled:opacity-60" />
                      <div className="mt-3 flex justify-end gap-2">
                        <button type="button" onClick={() => { setEditing(null); setValue(""); setError(null); }} className="cursor-pointer rounded-lg px-3 py-2 text-[13px] font-semibold text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]">Cancel</button>
                        <button type="submit" disabled={!value || busy === variable.name} className="cursor-pointer rounded-lg bg-[var(--color-ink)] px-3.5 py-2 text-[13px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-45">{busy === variable.name ? "Saving…" : "Save"}</button>
                      </div>
                    </form>
                  )}
                </div>
              ))}
            </div>
            {error && <p role="alert" className="mt-3 text-[13px] text-[#b4342b]">{error}</p>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function VariablesIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[15px] w-[15px]"><path d="M8 3H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2" /></svg>; }
function EyeIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="m3 3 18 18M10.6 10.6A2 2 0 0 0 13.4 13.4M9.9 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.1 3M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.1-.9"/></svg>; }
function MoreIcon() { return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-4 w-4"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>; }
function EditIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18"/></svg>; }
