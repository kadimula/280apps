"use client";

import { useCallback, useId, useState } from "react";

import {
  type AppVariable,
  deleteVariable,
  listVariables,
  revealVariable,
  setVariable,
} from "@/lib/variables";

// The variables surface, rendered inline inside the settings sidebar's Variables
// tab. Same behavior the old modal had — list, reveal, add, edit, delete — laid
// out for the 320px column instead of a centered dialog.
export function VariablesPanel({ app }: { app: { id: string; slug: string } }) {
  const [variables, setVariables] = useState<AppVariable[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const headingId = useId();

  const refresh = useCallback(async () => {
    const result = await listVariables(app.id);
    if ("error" in result) {
      setError(result.error);
      setVariables((current) => current ?? []);
    } else {
      setVariables(result.variables);
    }
  }, [app.id]);

  // Fire the initial load exactly once from a lazy initializer — this codebase
  // bans useEffect, and the sidebar remounts the panel per app so mounting is
  // the load trigger.
  useState(() => {
    void refresh();
  });

  function edit(name: string) {
    setMenu(null);
    setEditing(name);
    setValue("");
    setError(null);
  }

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
    <div className="flex flex-col gap-1">
      <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {variables === null
          ? "Variables"
          : `${variables.length} ${variables.length === 1 ? "variable" : "variables"}`}
      </h3>

      {variables === null && (
        <p className="px-1 py-4 text-[13px] text-[var(--color-muted)]">Loading&hellip;</p>
      )}
      {variables?.length === 0 && (
        <div className="py-6 text-center">
          <p className="text-[14px] font-semibold text-[var(--color-ink)]">No variables declared</p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            Add variable names to 280.json, then push the app again.
          </p>
        </div>
      )}

      {variables?.map((variable) => (
        <div key={variable.name} className="relative rounded-lg px-1.5 py-2 transition-colors hover:bg-[var(--color-paper-warm)]">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-[var(--color-ink)]" title={variable.name}>
              {variable.name}
            </p>
            {variable.kind === "config" && (
              <span className="shrink-0 rounded-full border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]" title="Config: a value the app reads via process.env">config</span>
            )}
            {variable.configured ? (
              <div className="relative shrink-0" data-variable-menu>
                <button type="button" onClick={() => setMenu((current) => (current === variable.name ? null : variable.name))} aria-label={`Actions for ${variable.name}`} aria-haspopup="menu" aria-expanded={menu === variable.name} className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
                  <MoreIcon />
                </button>
                {menu === variable.name && (
                  <>
                    <button type="button" aria-hidden tabIndex={-1} onClick={() => setMenu(null)} className="fixed inset-0 z-10 cursor-default" />
                    <div role="menu" className="absolute right-0 top-[calc(100%+4px)] z-20 w-[156px] rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-1.5 shadow-[0_18px_50px_-24px_rgba(10,10,10,0.65)]">
                      <button type="button" role="menuitem" onClick={() => edit(variable.name)} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-[var(--color-body)] transition-colors hover:bg-[var(--color-paper-warm)]"><EditIcon />Edit</button>
                      <button type="button" role="menuitem" onClick={() => remove(variable.name)} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-[#b4342b] transition-colors hover:bg-[var(--color-paper-warm)]"><TrashIcon />Delete</button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button type="button" onClick={() => edit(variable.name)} className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-line-strong)] px-2.5 py-1 text-[12px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]">Add</button>
            )}
          </div>

          {variable.configured && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--color-body)]">
                {revealed[variable.name] ?? "••••••••"}
              </span>
              <button type="button" onClick={() => toggleReveal(variable.name)} disabled={busy === variable.name} aria-label={revealed[variable.name] === undefined ? `Show ${variable.name}` : `Hide ${variable.name}`} className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-50">
                {revealed[variable.name] === undefined ? <EyeIcon /> : <EyeOffIcon />}
              </button>
            </div>
          )}

          {editing === variable.name && (
            <form onSubmit={save} className="mt-2">
              <label className="sr-only" htmlFor={`${headingId}-${variable.name}`}>Value for {variable.name}</label>
              <input autoFocus id={`${headingId}-${variable.name}`} type="password" value={value} onChange={(event) => { setValue(event.target.value); setError(null); }} placeholder="Enter value" autoComplete="new-password" disabled={busy === variable.name} className="w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-3 py-2 font-mono text-[13px] text-[var(--color-ink)] outline-none transition-colors placeholder:font-sans placeholder:text-[var(--color-muted)] focus:border-[var(--color-gold-500)] disabled:opacity-60" />
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => { setEditing(null); setValue(""); setError(null); }} className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]">Cancel</button>
                <button type="submit" disabled={!value || busy === variable.name} className="cursor-pointer rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-45">{busy === variable.name ? "Saving…" : "Save"}</button>
              </div>
            </form>
          )}
        </div>
      ))}

      {error && <p role="alert" className="mt-2 px-1 text-[13px] text-[#b4342b]">{error}</p>}
    </div>
  );
}

function EyeIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="m3 3 18 18M10.6 10.6A2 2 0 0 0 13.4 13.4M9.9 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.1 3M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.1-.9"/></svg>; }
function MoreIcon() { return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-4 w-4"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>; }
function EditIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/></svg>; }
