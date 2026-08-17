"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { openGooglePicker } from "@/lib/google-picker";
import {
  type IntegrationCatalog,
  type IntegrationConnection,
  type IntegrationProvider,
  disconnect as disconnectConnection,
  listIntegrations,
  mockConnect,
  registerResource,
  removeResource,
  selectorSession,
} from "@/lib/integrations";
import { MOCK_SHEETS, type PickedSheet } from "@/lib/mock-sheets";

type AddingState = { connectionId: string; file: PickedSheet };

function providerLabel(provider: IntegrationProvider): string {
  if (provider.capabilities.includes("google-sheets")) return "Google Sheets";
  return provider.provider.charAt(0).toUpperCase() + provider.provider.slice(1);
}

function aliasFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "sheet";
}

export function IntegrationsDialog({
  app,
  apiBase,
  mock,
  autoOpen = false,
}: {
  app: { id: string; slug: string };
  apiBase: string;
  mock: boolean;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<IntegrationCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddingState | null>(null);
  const [alias, setAlias] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const headingId = useId();

  const refresh = useCallback(async () => {
    const result = await listIntegrations(app.id);
    if ("error" in result) {
      setError(result.error);
      setData((current) => current ?? { providers: [], connections: [] });
    } else {
      setData(result);
    }
  }, [app.id]);

  function openDialog() {
    setOpen(true);
    void refresh();
  }

  // Open from a client-only effect, never from initial state: seeding open from
  // autoOpen would evaluate createPortal(..., document.body) during SSR, where
  // document is undefined, and throw at render time. autoOpen fires when the
  // owner lands back here after the OAuth redirect (?integrations=1).
  useEffect(() => {
    if (autoOpen) queueMicrotask(() => { setOpen(true); void refresh(); });
  }, [autoOpen, refresh]);

  function close() {
    setOpen(false);
    setData(null);
    setError(null);
    setBusy(null);
    setPicking(null);
    setAdding(null);
    setAlias("");
    setAliasError(null);
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (adding) cancelAdd();
      else if (picking) setPicking(null);
      else close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, picking, adding]);

  // Connect (or reconnect) a provider. In a live environment this is a top-level
  // navigation to the backend's OAuth start, which sets the state cookie, bounces
  // through Google, and returns to this page with ?integrations=1. With the mock
  // backend there is no Google to reach, so a single call stands the connection up.
  async function connect(provider: string) {
    if (mock) {
      setBusy(`connect:${provider}`);
      setError(null);
      const failure = await mockConnect(app.id, provider);
      if (failure) setError(failure.error);
      else await refresh();
      setBusy(null);
      return;
    }
    const redirect = `/dashboard/${app.id}?integrations=1`;
    window.location.assign(
      `${apiBase}/internal/apps/${encodeURIComponent(app.id)}/integrations/${encodeURIComponent(provider)}/start?redirect=${encodeURIComponent(redirect)}`,
    );
  }

  // Open the Picker for a connection. Both paths first mint a selector session so
  // the real drive.file token (or the mock's inert stand-in) is exercised; the
  // real path then loads the Google Picker, the mock path reveals a canned list.
  async function pick(connection: IntegrationConnection) {
    setBusy(`pick:${connection.id}`);
    setError(null);
    const session = await selectorSession(app.id, connection.id);
    setBusy(null);
    if ("error" in session) {
      setError(session.error);
      return;
    }
    if (mock) {
      setPicking(connection.id);
      return;
    }
    try {
      const file = await openGooglePicker(session);
      if (file) startAlias(connection.id, file);
    } catch {
      setError("The Google Picker could not be opened.");
    }
  }

  function startAlias(connectionId: string, file: PickedSheet) {
    setPicking(null);
    setAdding({ connectionId, file });
    setAlias(aliasFromName(file.name));
    setAliasError(null);
  }

  function cancelAdd() {
    setAdding(null);
    setAlias("");
    setAliasError(null);
  }

  async function saveAlias(event: React.FormEvent) {
    event.preventDefault();
    if (!adding || !alias || busy) return;
    setBusy(`alias:${adding.connectionId}`);
    setAliasError(null);
    const result = await registerResource(
      app.id,
      adding.connectionId,
      "google-sheets",
      alias,
      adding.file.id,
    );
    if ("error" in result) setAliasError(result.error);
    else {
      cancelAdd();
      await refresh();
    }
    setBusy(null);
  }

  async function detach(connectionId: string, resourceId: string) {
    setBusy(`resource:${resourceId}`);
    setError(null);
    const failure = await removeResource(app.id, resourceId);
    if (failure) setError(failure.error);
    else await refresh();
    setBusy(null);
  }

  async function disconnect(connection: IntegrationConnection) {
    setBusy(`disconnect:${connection.id}`);
    setError(null);
    const failure = await disconnectConnection(app.id, connection.id);
    if (failure) setError(failure.error);
    else await refresh();
    setBusy(null);
  }

  const connectionFor = (provider: string) =>
    data?.connections.find((c) => c.provider === provider) ?? null;

  return (
    <>
      <button type="button" onClick={openDialog} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]">
        <PlugIcon />
        Integrations
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(10,10,10,0.66)] px-6 py-[68px] backdrop-blur-[1px]" onClick={(event) => event.target === event.currentTarget && close()}>
          <div role="dialog" aria-modal="true" aria-labelledby={headingId} className="w-full max-w-[560px] rounded-[18px] border border-[var(--color-line)] bg-[var(--color-paper)] px-6 pb-5 pt-6 shadow-[0_24px_70px_-18px_rgba(10,10,10,0.55)]">
            <div className="flex items-center justify-between gap-3">
              <h2 id={headingId} className="min-w-0 truncate font-sans text-[1.5rem] leading-tight tracking-tight text-[var(--color-ink)]">
                Integrations for <span className="text-[var(--color-muted)]">&ldquo;{app.slug}&rdquo;</span>
              </h2>
              <button type="button" onClick={close} aria-label="Close integrations" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]">
                <CloseIcon />
              </button>
            </div>

            <div className="mt-5 border-t border-[var(--color-line)] pt-4">
              {data === null && <p className="py-5 text-[13px] text-[var(--color-muted)]">Loading&hellip;</p>}

              {data?.providers.length === 0 && (
                <div className="py-7 text-center">
                  <p className="text-[14px] font-semibold text-[var(--color-ink)]">No integrations available</p>
                  <p className="mt-1 text-[13px] text-[var(--color-muted)]">This platform has no integration providers configured.</p>
                </div>
              )}

              {data?.providers.map((provider) => {
                const connection = connectionFor(provider.provider);
                const label = providerLabel(provider);
                return (
                  <div key={provider.provider} className="rounded-xl border border-[var(--color-line)] p-4">
                    <div className="flex items-center gap-3">
                      <SheetsIcon />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-semibold text-[var(--color-ink)]">{label}</p>
                        {connection ? (
                          <p className="truncate text-[12.5px] text-[var(--color-muted)]">{connection.account}</p>
                        ) : (
                          <p className="truncate text-[12.5px] text-[var(--color-muted)]">Read, append, and update spreadsheets from your app.</p>
                        )}
                      </div>
                      {connection ? (
                        connection.status === "reauthorization_required" ? (
                          <span className="shrink-0 rounded-full border border-[#c98a2b] bg-[rgba(201,138,43,0.12)] px-2.5 py-0.5 text-[11px] font-semibold text-[#c98a2b]">Reconnect needed</span>
                        ) : (
                          <span className="shrink-0 rounded-full border border-[var(--color-line-strong)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--color-muted)]">Connected</span>
                        )
                      ) : (
                        <button type="button" onClick={() => connect(provider.provider)} disabled={busy === `connect:${provider.provider}`} className="shrink-0 cursor-pointer rounded-lg bg-[var(--color-ink)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-45">
                          {busy === `connect:${provider.provider}` ? "Connecting…" : "Connect"}
                        </button>
                      )}
                    </div>

                    {connection?.status === "reauthorization_required" && (
                      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-[var(--color-paper-warm)] px-3 py-2.5">
                        <p className="text-[12.5px] text-[var(--color-body)]">Google access expired. Reconnect to keep this integration working.</p>
                        <button type="button" onClick={() => connect(connection.provider)} disabled={busy === `connect:${connection.provider}`} className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-line-strong)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]">Reconnect</button>
                      </div>
                    )}

                    {connection && (
                      <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                        {connection.resources.length === 0 && picking !== connection.id && (
                          <p className="pb-2 text-[12.5px] text-[var(--color-muted)]">No spreadsheets added yet.</p>
                        )}

                        {connection.resources.map((resource) => (
                          <div key={resource.id} className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--color-paper-warm)]">
                            <span className="shrink-0 font-mono text-[12px] text-[var(--color-muted)]">{"{}"}</span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-mono text-[13px] font-medium text-[var(--color-ink)]">{resource.alias}</p>
                              <p className="truncate text-[12px] text-[var(--color-muted)]">{resource.displayName}</p>
                            </div>
                            <button type="button" onClick={() => detach(connection.id, resource.id)} disabled={busy === `resource:${resource.id}`} aria-label={`Remove ${resource.alias}`} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[#b4342b] disabled:opacity-50">
                              <TrashIcon />
                            </button>
                          </div>
                        ))}

                        {picking === connection.id && (
                          <div className="mt-1 rounded-lg border border-[var(--color-line)] p-2">
                            <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Pick a spreadsheet</p>
                            {MOCK_SHEETS.map((sheet) => (
                              <button key={sheet.id} type="button" onClick={() => startAlias(connection.id, sheet)} className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] text-[var(--color-body)] transition-colors hover:bg-[var(--color-paper-warm)]">
                                <SheetsIcon />
                                {sheet.name}
                              </button>
                            ))}
                            <button type="button" onClick={() => setPicking(null)} className="mt-1 cursor-pointer rounded-md px-2.5 py-1.5 text-[12.5px] font-semibold text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]">Cancel</button>
                          </div>
                        )}

                        {adding?.connectionId === connection.id ? (
                          <form onSubmit={saveAlias} className="mt-2 rounded-lg bg-[var(--color-paper-warm)] p-3">
                            <p className="pb-2 text-[12.5px] text-[var(--color-body)]">Name for <span className="font-semibold text-[var(--color-ink)]">{adding.file.name}</span>. Your app references this alias.</p>
                            <label className="sr-only" htmlFor={`${headingId}-alias`}>Alias</label>
                            <input id={`${headingId}-alias`} value={alias} onChange={(event) => { setAlias(event.target.value); setAliasError(null); }} placeholder="orders" autoFocus disabled={busy === `alias:${connection.id}`} className="w-full rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-2.5 font-mono text-[14px] text-[var(--color-ink)] outline-none transition-colors placeholder:font-sans placeholder:text-[var(--color-muted)] focus:border-[var(--color-gold-500)] disabled:opacity-60" />
                            {aliasError && <p role="alert" className="mt-2 text-[12.5px] text-[#b4342b]">{aliasError}</p>}
                            <div className="mt-3 flex justify-end gap-2">
                              <button type="button" onClick={cancelAdd} className="cursor-pointer rounded-lg px-3 py-2 text-[13px] font-semibold text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">Cancel</button>
                              <button type="submit" disabled={!alias || busy === `alias:${connection.id}`} className="cursor-pointer rounded-lg bg-[var(--color-ink)] px-3.5 py-2 text-[13px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-45">{busy === `alias:${connection.id}` ? "Adding…" : "Add"}</button>
                            </div>
                          </form>
                        ) : (
                          !picking && (
                            <div className="mt-1 flex items-center justify-between">
                              <button type="button" onClick={() => pick(connection)} disabled={busy === `pick:${connection.id}` || connection.status === "reauthorization_required"} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-line-strong)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)] disabled:cursor-default disabled:opacity-45">
                                <PlusIcon />
                                {busy === `pick:${connection.id}` ? "Opening…" : "Add spreadsheet"}
                              </button>
                              <button type="button" onClick={() => disconnect(connection)} disabled={busy === `disconnect:${connection.id}`} className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-semibold text-[#b4342b] transition-colors hover:bg-[var(--color-paper-warm)] disabled:opacity-50">{busy === `disconnect:${connection.id}` ? "Disconnecting…" : "Disconnect"}</button>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {error && <p role="alert" className="mt-3 text-[13px] text-[#b4342b]">{error}</p>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function PlugIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[15px] w-[15px]"><path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v6" /></svg>; }
function SheetsIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[18px] w-[18px] shrink-0 text-[var(--color-muted)]"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 9v12M15 9v12" /></svg>; }
function PlusIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5"><path d="M12 5v14M5 12h14" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18"/></svg>; }
