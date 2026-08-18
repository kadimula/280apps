"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openGooglePicker } from "@/lib/google-picker";
import {
  type IntegrationCatalog,
  type IntegrationConnection,
  type IntegrationProvider,
  type IntegrationRequirement,
  type IntegrationResource,
  disconnect as disconnectConnection,
  listIntegrations,
  mockConnect,
  registerResource,
  removeResource,
  selectorSession,
} from "@/lib/integrations";
import { MOCK_SHEETS, type PickedSheet } from "@/lib/mock-sheets";

type AddingState = {
  connectionId: string;
  file: PickedSheet;
  capability: string;
  requiredAlias: string;
};

// A pending destructive action awaiting confirmation because it would un-ready a
// required alias (the deploy would park again). Held until the owner confirms.
type PendingConfirm =
  | { kind: "disconnect"; connectionId: string }
  | { kind: "detach"; connectionId: string; resourceId: string };

function providerLabel(provider: IntegrationProvider): string {
  if (provider.capabilities.includes("google-sheets")) return "Google Sheets";
  return provider.provider.charAt(0).toUpperCase() + provider.provider.slice(1);
}

function capabilityLabel(capability: string): string {
  if (capability === "google-sheets") return "Google Sheets";
  return capability;
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
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // The requirement a picker flow is fulfilling. A ref, not state, so the async
  // pick → startAlias handoff always reads the current target with no stale closure.
  const bindTarget = useRef<IntegrationRequirement | null>(null);
  const headingId = useId();

  const refresh = useCallback(async () => {
    const result = await listIntegrations(app.id);
    if ("error" in result) {
      setError(result.error);
      setData((current) => current ?? { providers: [], connections: [], requirements: [] });
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
    setPendingConfirm(null);
    bindTarget.current = null;
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (adding) cancelAdd();
      else if (picking) cancelPick();
      else if (pendingConfirm) setPendingConfirm(null);
      else close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, picking, adding, pendingConfirm]);

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

  async function pick(connection: IntegrationConnection, target: IntegrationRequirement) {
    bindTarget.current = target;
    setBusy(`pick:${connection.id}`);
    setError(null);
    const session = await selectorSession(app.id, connection.id);
    setBusy(null);
    if ("error" in session) {
      bindTarget.current = null;
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
      else bindTarget.current = null;
    } catch {
      bindTarget.current = null;
      setError("The Google Picker could not be opened.");
    }
  }

  function pickForRequirement(req: IntegrationRequirement) {
    const connection = connectionForCapability(req.capability);
    if (connection) void pick(connection, req);
  }

  function startAlias(connectionId: string, file: PickedSheet) {
    const target = bindTarget.current;
    bindTarget.current = null;
    setPicking(null);
    if (!target) return;
    setAdding({ connectionId, file, capability: target.capability, requiredAlias: target.alias });
    setAlias(target.alias);
    setAliasError(null);
  }

  function cancelPick() {
    bindTarget.current = null;
    setPicking(null);
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
      adding.capability,
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
    setPendingConfirm(null);
    const failure = await removeResource(app.id, resourceId);
    if (failure) setError(failure.error);
    else await refresh();
    setBusy(null);
  }

  async function disconnect(connection: IntegrationConnection) {
    setBusy(`disconnect:${connection.id}`);
    setError(null);
    setPendingConfirm(null);
    const failure = await disconnectConnection(app.id, connection.id);
    if (failure) setError(failure.error);
    else await refresh();
    setBusy(null);
  }

  const connectionFor = (provider: string) =>
    data?.connections.find((c) => c.provider === provider) ?? null;

  const providerNameForCapability = (capability: string) =>
    data?.providers.find((p) => p.capabilities.includes(capability))?.provider ?? null;

  const connectionForCapability = (capability: string) => {
    const name = providerNameForCapability(capability);
    return name ? connectionFor(name) : null;
  };

  // The resource, if any, bound to a declared required alias. A requirement is
  // ready only when such a resource exists (mirrors the backend's binding gate).
  const bindingFor = (req: IntegrationRequirement): { connection: IntegrationConnection; resource: IntegrationResource } | null => {
    for (const c of data?.connections ?? []) {
      const resource = c.resources.find((r) => r.capability === req.capability && r.alias === req.alias);
      if (resource) return { connection: c, resource };
    }
    return null;
  };

  const requirements = data?.requirements ?? [];
  // Resource ids that satisfy a requirement: removing one un-readies its deploy.
  const requiredResourceIds = new Set(
    requirements.map((r) => bindingFor(r)?.resource.id).filter((id): id is string => !!id),
  );
  const connectionHasRequired = (connection: IntegrationConnection) =>
    connection.resources.some((r) => requiredResourceIds.has(r.id));

  function onDisconnect(connection: IntegrationConnection) {
    if (connectionHasRequired(connection)) setPendingConfirm({ kind: "disconnect", connectionId: connection.id });
    else void disconnect(connection);
  }

  function onDetach(connectionId: string, resource: IntegrationResource) {
    if (requiredResourceIds.has(resource.id)) setPendingConfirm({ kind: "detach", connectionId, resourceId: resource.id });
    else void detach(connectionId, resource.id);
  }

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

              {requirements.length > 0 ? (
                <section className="mb-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Required by your app</p>
                  <p className="mt-1 text-[13px] text-[var(--color-body)]">Complete each requirement so new deployments of <span className="font-semibold text-[var(--color-ink)]">{app.slug}</span> can go live.</p>
                  <div className="mt-3 space-y-2">
                    {requirements.map((req) => (
                      <RequirementRow
                        key={`${req.capability}:${req.alias}`}
                        req={req}
                        binding={bindingFor(req)}
                        connection={connectionForCapability(req.capability)}
                        busy={busy}
                        onConnect={() => connect(providerNameForCapability(req.capability) ?? "")}
                        onPick={() => pickForRequirement(req)}
                      />
                    ))}
                  </div>
                </section>
              ) : data !== null ? (
                <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-5 py-8 text-center">
                  <p className="text-[14px] font-semibold text-[var(--color-ink)]">No integrations requested</p>
                  <p className="mx-auto mt-1 max-w-[360px] text-[13px] leading-relaxed text-[var(--color-muted)]">This app has no integration requirements in its manifest. Integrations will appear here when the app requests them.</p>
                </div>
              ) : null}

              {(data?.connections.length ?? 0) > 0 && (
                <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Connected accounts</p>
              )}
              {data?.connections.map((connection) => {
                const provider = data.providers.find((candidate) => candidate.provider === connection.provider);
                if (!provider) return null;
                const label = providerLabel(provider);
                return (
                  <div key={connection.id} className="rounded-xl border border-[var(--color-line)] p-4">
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
                      {connection.status === "reauthorization_required" ? (
                        <span className="shrink-0 rounded-full border border-[#c98a2b] bg-[rgba(201,138,43,0.12)] px-2.5 py-0.5 text-[11px] font-semibold text-[#c98a2b]">Reconnect needed</span>
                      ) : (
                        <span className="shrink-0 rounded-full border border-[var(--color-line-strong)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--color-muted)]">Connected</span>
                      )}
                    </div>

                    {connection?.status === "reauthorization_required" && (
                      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-[var(--color-paper-warm)] px-3 py-2.5">
                        <p className="text-[12.5px] text-[var(--color-body)]">Google access expired. Reconnect to keep this integration working.</p>
                        <button type="button" onClick={() => connect(connection.provider)} disabled={busy === `connect:${connection.provider}`} className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-line-strong)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]">Reconnect</button>
                      </div>
                    )}

                    <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                        {connection.resources.length === 0 && picking !== connection.id && adding?.connectionId !== connection.id && (
                          <p className="pb-2 text-[12.5px] text-[var(--color-muted)]">No spreadsheets added yet.</p>
                        )}

                        {connection.resources.map((resource) => (
                          <div key={resource.id} className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--color-paper-warm)]">
                            <span className="shrink-0 font-mono text-[12px] text-[var(--color-muted)]">{"{}"}</span>
                            <div className="min-w-0 flex-1">
                              <p className="flex items-center gap-2 truncate font-mono text-[13px] font-medium text-[var(--color-ink)]">
                                {resource.alias}
                                {requiredResourceIds.has(resource.id) && (
                                  <span className="shrink-0 rounded-full border border-[var(--color-line-strong)] px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Required</span>
                                )}
                              </p>
                              <p className="truncate text-[12px] text-[var(--color-muted)]">{resource.displayName}</p>
                            </div>
                            <button type="button" onClick={() => onDetach(connection.id, resource)} disabled={busy === `resource:${resource.id}`} aria-label={`Remove ${resource.alias}`} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[#b4342b] disabled:opacity-50">
                              <TrashIcon />
                            </button>
                          </div>
                        ))}

                        {pendingConfirm?.kind === "detach" && pendingConfirm.connectionId === connection.id && (
                          <ConfirmRow
                            message="Integration calls using this spreadsheet will fail, and future deployments will wait until you connect one again."
                            busy={busy !== null}
                            onConfirm={() => detach(connection.id, pendingConfirm.resourceId)}
                            onCancel={() => setPendingConfirm(null)}
                          />
                        )}

                        {picking === connection.id && (
                          <div className="mt-1 rounded-lg border border-[var(--color-line)] p-2">
                            <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Pick a spreadsheet</p>
                            {MOCK_SHEETS.map((sheet) => (
                              <button key={sheet.id} type="button" onClick={() => startAlias(connection.id, sheet)} className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] text-[var(--color-body)] transition-colors hover:bg-[var(--color-paper-warm)]">
                                <SheetsIcon />
                                {sheet.name}
                              </button>
                            ))}
                            <button type="button" onClick={cancelPick} className="mt-1 cursor-pointer rounded-md px-2.5 py-1.5 text-[12.5px] font-semibold text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]">Cancel</button>
                          </div>
                        )}

                        {adding?.connectionId === connection.id ? (
                          <form onSubmit={saveAlias} className="mt-2 rounded-lg bg-[var(--color-paper-warm)] p-3">
                            <p className="pb-2 text-[12.5px] text-[var(--color-body)]">Binding <span className="font-semibold text-[var(--color-ink)]">{adding.file.name}</span> to the alias <span className="font-mono font-semibold text-[var(--color-ink)]">{adding.requiredAlias}</span> your app requires.</p>
                            <label className="sr-only" htmlFor={`${headingId}-alias`}>Alias</label>
                            <input id={`${headingId}-alias`} value={alias} readOnly disabled={busy === `alias:${connection.id}`} className="w-full rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-2.5 font-mono text-[14px] text-[var(--color-ink)] outline-none read-only:opacity-70 disabled:opacity-60" />
                            {aliasError && <p role="alert" className="mt-2 text-[12.5px] text-[#b4342b]">{aliasError}</p>}
                            <div className="mt-3 flex justify-end gap-2">
                              <button type="button" onClick={cancelAdd} className="cursor-pointer rounded-lg px-3 py-2 text-[13px] font-semibold text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">Cancel</button>
                              <button type="submit" disabled={!alias || busy === `alias:${connection.id}`} className="cursor-pointer rounded-lg bg-[var(--color-ink)] px-3.5 py-2 text-[13px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-45">{busy === `alias:${connection.id}` ? "Connecting…" : "Connect"}</button>
                            </div>
                          </form>
                        ) : (
                          !picking && pendingConfirm?.connectionId !== connection.id && (
                            <div className="mt-1 flex justify-end">
                              <button type="button" onClick={() => onDisconnect(connection)} disabled={busy === `disconnect:${connection.id}`} className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-semibold text-[#b4342b] transition-colors hover:bg-[var(--color-paper-warm)] disabled:opacity-50">{busy === `disconnect:${connection.id}` ? "Disconnecting…" : "Disconnect"}</button>
                            </div>
                          )
                        )}

                        {pendingConfirm?.kind === "disconnect" && pendingConfirm.connectionId === connection.id && (
                          <ConfirmRow
                            message="Integration calls using this account will fail, and future deployments will wait until you reconnect and choose the required spreadsheets."
                            confirmLabel="Disconnect anyway"
                            busy={busy !== null}
                            onConfirm={() => disconnect(connection)}
                            onCancel={() => setPendingConfirm(null)}
                          />
                        )}
                    </div>
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

function RequirementRow({
  req,
  binding,
  connection,
  busy,
  onConnect,
  onPick,
}: {
  req: IntegrationRequirement;
  binding: { connection: IntegrationConnection; resource: IntegrationResource } | null;
  connection: IntegrationConnection | null;
  busy: string | null;
  onConnect: () => void;
  onPick: () => void;
}) {
  const needsReconnect =
    (binding && binding.connection.status === "reauthorization_required") ||
    (!binding && connection?.status === "reauthorization_required");
  const ready = !!binding && !needsReconnect;
  const context = `${capabilityLabel(req.capability)} · ${req.operations.join(", ")}`;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2.5">
      <span className="shrink-0 font-mono text-[12px] text-[var(--color-muted)]">{"{}"}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[13px] font-semibold text-[var(--color-ink)]">{req.alias}</p>
        <p className="truncate text-[12px] text-[var(--color-muted)]">
          {ready ? `${capabilityLabel(req.capability)} · ${binding!.resource.displayName}` : context}
        </p>
      </div>
      {ready ? (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#2f8f5b] bg-[rgba(47,143,91,0.12)] px-2.5 py-0.5 text-[11px] font-semibold text-[#2f8f5b]">
          <CheckIcon />
          Ready
        </span>
      ) : needsReconnect ? (
        <button type="button" onClick={onConnect} disabled={busy === `connect:${connection?.provider}`} className="shrink-0 cursor-pointer rounded-lg border border-[#c98a2b] px-3 py-1.5 text-[12.5px] font-semibold text-[#c98a2b] transition-colors hover:bg-[rgba(201,138,43,0.12)] disabled:opacity-50">Reconnect</button>
      ) : connection ? (
        <button type="button" onClick={onPick} disabled={busy === `pick:${connection.id}`} className="shrink-0 cursor-pointer rounded-lg bg-[var(--color-ink)] px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:opacity-45">{busy === `pick:${connection.id}` ? "Opening…" : "Choose spreadsheet"}</button>
      ) : (
        <button type="button" onClick={onConnect} disabled={busy?.startsWith("connect:")} className="shrink-0 cursor-pointer rounded-lg bg-[var(--color-ink)] px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90 disabled:opacity-45">Connect</button>
      )}
    </div>
  );
}

function ConfirmRow({
  message,
  confirmLabel = "Remove",
  busy,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-[#c98a2b] bg-[rgba(201,138,43,0.1)] p-3">
      <p className="text-[12.5px] text-[var(--color-body)]">{message}</p>
      <div className="mt-2.5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-semibold text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy} className="cursor-pointer rounded-lg bg-[#b4342b] px-3.5 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50">{confirmLabel}</button>
      </div>
    </div>
  );
}

function PlugIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[15px] w-[15px]"><path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v6" /></svg>; }
function SheetsIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[18px] w-[18px] shrink-0 text-[var(--color-muted)]"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 9v12M15 9v12" /></svg>; }
function CheckIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3 w-3"><path d="M20 6 9 17l-5-5" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18"/></svg>; }
