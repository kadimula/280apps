"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openGooglePicker } from "@/lib/google-picker";
import {
  type IntegrationCatalog,
  type IntegrationConnection,
  type IntegrationRequirement,
  type IntegrationResource,
  disconnect as disconnectConnection,
  listIntegrations,
  mockConnect,
  registerResource,
  selectorSession,
} from "@/lib/integrations";
import { MOCK_SHEETS, type PickedSheet } from "@/lib/mock-sheets";

type ErrorKind = "oauth" | "picker" | "resource" | "platform";

type PhaseState =
  | { phase: "loading" }
  | { phase: "connect" }
  | { phase: "returning" }
  | { phase: "choose"; unmetCount: number; afterCancel?: boolean }
  | { phase: "picking"; target: IntegrationRequirement; connectionId: string }
  | { phase: "binding"; file: PickedSheet; target: IntegrationRequirement }
  | { phase: "success" }
  | { phase: "ready" }
  | { phase: "reconnect"; connection: IntegrationConnection }
  | { phase: "error"; kind: ErrorKind; target?: IntegrationRequirement; file?: PickedSheet }
  | { phase: "confirmDisconnect"; connection: IntegrationConnection };

function humanizeAlias(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1).replace(/[-_]/g, " ");
}

function operationsLabel(ops: string[]): string {
  if (ops.length === 0) return "";
  const human: Record<string, string> = { read: "read", write: "write", append: "add rows", update: "update", delete: "delete" };
  const mapped = ops.map((o) => human[o] ?? o);
  if (mapped.length <= 2) return mapped.join(" and ");
  return mapped.slice(0, -1).join(", ") + ", and " + mapped[mapped.length - 1];
}

export function IntegrationsDialog({
  app,
  apiBase,
  mock,
  autoOpen = false,
  oauthError = false,
}: {
  app: { id: string; slug: string };
  apiBase: string;
  mock: boolean;
  autoOpen?: boolean;
  oauthError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<IntegrationCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<PhaseState>({ phase: "loading" });
  const autoContinueConsumed = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const liveRegionId = useId();

  const refresh = useCallback(async () => {
    const result = await listIntegrations(app.id);
    if ("error" in result) {
      setError(result.error);
      setData((current) => current ?? { providers: [], connections: [], requirements: [] });
    } else {
      setData(result);
    }
  }, [app.id]);

  function derivePhase(catalog: IntegrationCatalog, oauthFailed: boolean, isAutoOpenReturn: boolean): PhaseState {
    const reqs = catalog.requirements;
    const conn = catalog.connections[0] ?? null;

    if (oauthFailed) return { phase: "error", kind: "oauth" };

    if (!conn && reqs.length === 0) return { phase: "ready" };

    if (!conn) return { phase: "connect" };

    if (conn.status === "reauthorization_required") return { phase: "reconnect", connection: conn };

    const unmet = reqs.filter(
      (r) => !conn.resources.some((res) => res.capability === r.capability && res.alias === r.alias),
    );

    if (unmet.length === 0) {
      return { phase: reqs.length > 0 ? "ready" : "success" };
    }

    if (isAutoOpenReturn && !autoContinueConsumed.current) {
      return { phase: "returning" };
    }

    return { phase: "choose", unmetCount: unmet.length };
  }

  function openDialog() {
    setOpen(true);
    setPhase({ phase: "loading" });
    void refresh().then(() => {});
  }

  useEffect(() => {
    if (!autoOpen) return;
    queueMicrotask(() => {
      setOpen(true);
      setPhase({ phase: "loading" });
      void refresh().then(() => {});
    });
  }, [autoOpen, refresh]);

  // Drive phase from catalog changes. The isAutoOpenReturn flag is only true on
  // the first load after an OAuth return (autoOpen + data arrived).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!data) return;
    const isAutoOpenReturn = autoOpen && !wasOpenRef.current;
    wasOpenRef.current = open;

    if (phase.phase === "loading" || phase.phase === "connect" || phase.phase === "reconnect") {
      setPhase(derivePhase(data, oauthError, isAutoOpenReturn));
      return;
    }
    if (phase.phase === "returning" || phase.phase === "picking") return;
    if (phase.phase === "binding") {
      const derived = derivePhase(data, false, false);
      // Show success after final binding; derived ready for subsequent ones
      setPhase(derived.phase === "ready" ? { phase: "success" } : derived);
      return;
    }
    if (phase.phase === "success" || phase.phase === "ready") {
      const derived = derivePhase(data, false, false);
      if (derived.phase !== "ready" && derived.phase !== "success") setPhase(derived);
      return;
    }
    // intentional: only re-derive on catalog changes, not on every phase/prop change
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Automatic Picker continuation after OAuth return.
  useEffect(() => {
    if (phase.phase !== "returning" || autoContinueConsumed.current || !data) return;
    autoContinueConsumed.current = true;
    const conn = data.connections[0];
    const unmet = data.requirements.filter(
      (r) => !conn.resources.some((res) => res.capability === r.capability && res.alias === r.alias),
    );
    if (unmet.length === 0) return;
    void startPick(conn, unmet[0]);
  }, [phase.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus trap and restoration.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (phase.phase === "confirmDisconnect") { setPhase(derivePhase(data!, false, false)); return; }
      if (phase.phase === "picking") { cancelPick(); return; }
      if (phase.phase === "success" || phase.phase === "ready") { close(); return; }
      if (phase.phase === "error" && phase.kind === "resource") {
        setPhase({ phase: "choose", unmetCount: 1 });
        return;
      }
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, phase.phase, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus first actionable element on phase change.
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const el = dialogRef.current.querySelector<HTMLElement>("button.primary-action, button:not([aria-label])");
    if (el) el.focus();
  }, [open, phase.phase]);

  function close() {
    setOpen(false);
    setData(null);
    setError(null);
    setBusy(false);
    setPhase({ phase: "loading" });
    autoContinueConsumed.current = false;
    wasOpenRef.current = false;
    triggerRef.current?.focus();
  }

  async function connect(provider: string) {
    if (mock) {
      setBusy(true);
      setError(null);
      const failure = await mockConnect(app.id, provider);
      if (failure) setError(failure.error);
      else await refresh();
      setBusy(false);
      return;
    }
    const redirect = `/dashboard/${app.id}?integrations=1`;
    window.location.assign(
      `${apiBase}/internal/apps/${encodeURIComponent(app.id)}/integrations/${encodeURIComponent(provider)}/start?redirect=${encodeURIComponent(redirect)}`,
    );
  }

  async function startPick(connection: IntegrationConnection, target: IntegrationRequirement) {
    setBusy(true);
    setError(null);
    const session = await selectorSession(app.id, connection.id);
    setBusy(false);
    if ("error" in session) {
      setPhase({ phase: "error", kind: "picker", target });
      return;
    }
    if (mock) {
      setPhase({ phase: "picking", target, connectionId: connection.id });
      return;
    }
    try {
      const title = `Choose the spreadsheet for ${humanizeAlias(target.alias)}`;
      const file = await openGooglePicker(session, title);
      if (file) bindResource(file, target);
      else {
        // Picker cancelled cleanly.
      }
    } catch {
      setPhase({ phase: "error", kind: "picker", target });
    }
  }

  function cancelPick() {
    const derived = data ? derivePhase(data, false, false) : { phase: "connect" as const };
    setPhase(derived.phase === "choose" ? { ...derived, afterCancel: true } : derived);
  }

  function pickForRequirement(req: IntegrationRequirement) {
    const conn = data?.connections[0];
    if (!conn) return;
    void startPick(conn, req);
  }

  function mockSelectSheet(sheet: PickedSheet) {
    if (phase.phase !== "picking") return;
    bindResource(sheet, phase.target);
  }

  async function bindResource(file: PickedSheet, target: IntegrationRequirement) {
    const conn = data?.connections[0];
    if (!conn) return;
    setPhase({ phase: "binding", file, target });
    setError(null);
    const result = await registerResource(app.id, conn.id, target.capability, target.alias, file.id);
    if ("error" in result) {
      setPhase({ phase: "error", kind: "resource", target, file });
    } else {
      await refresh();
    }
    setBusy(false);
  }

  async function disconnectConn(connection: IntegrationConnection) {
    setBusy(true);
    setError(null);
    setPhase({ phase: "loading" });
    const failure = await disconnectConnection(app.id, connection.id);
    if (failure) setError(failure.error);
    else await refresh();
    setBusy(false);
  }

  // Reconnect: restart OAuth for the provider, same as initial connect.
  function reconnect(connection: IntegrationConnection) {
    void connect(connection.provider);
  }

  const bindingFor = (req: IntegrationRequirement): { connection: IntegrationConnection; resource: IntegrationResource } | null => {
    for (const c of data?.connections ?? []) {
      const resource = c.resources.find((r) => r.capability === req.capability && r.alias === req.alias);
      if (resource) return { connection: c, resource };
    }
    return null;
  };

  const conn = data?.connections[0] ?? null;
  const requirements = data?.requirements ?? [];
  const unmetReqs = requirements.filter((r) => !bindingFor(r));

  function renderPhase() {
    switch (phase.phase) {
      case "loading":
        return (
          <FocusContent
            icon="spinner"
            title="Getting Google Sheets ready"
            body={`Checking what ${app.slug} needs and whether Google is already connected.`}
            helper="This usually takes a moment."
          />
        );

      case "connect":
        return (
          <FocusContent
            icon="provider"
            title="Connect Google Sheets"
            body={`${app.slug} needs a spreadsheet for ${humanizeAlias(unmetReqs[0]?.alias ?? "data")}. Connect Google to choose it next.`}
            action={
              <GoogleButton onClick={() => connect("google")} disabled={busy}>
                {busy ? "Connecting…" : "Connect Google Sheets"}
              </GoogleButton>
            }
            helper="280 can only use spreadsheets you choose."
            tech={unmetReqs[0]}
          />
        );

      case "returning":
        return (
          <FocusContent
            icon="success"
            title="Google Sheets connected"
            body={`Connected as ${conn?.account ?? "your Google account"}. Opening your spreadsheets for the ${humanizeAlias(unmetReqs[0]?.alias ?? "")} setup.`}
            extra={<Spinner label="Opening Google Picker" />}
            helper="The Google Picker opens automatically."
          />
        );

      case "choose": {
        const chooseTitle = unmetReqs.length > 1
          ? `Choose ${unmetReqs.length} more ${unmetReqs.length === 1 ? "spreadsheet" : "spreadsheets"}`
          : `Choose the ${humanizeAlias(unmetReqs[0]?.alias ?? "")} spreadsheet`;
        const chooseBody = phase.afterCancel && unmetReqs.length === 1
          ? `No spreadsheet was selected. Choose the sheet ${app.slug} should use for ${humanizeAlias(unmetReqs[0]?.alias ?? "data")}.`
          : `${app.slug} needs ${unmetReqs.length > 1 ? `a separate spreadsheet for each job` : `the sheet ${app.slug} should use for ${humanizeAlias(unmetReqs[0]?.alias ?? "data")}`}.`;
        return (
          <SetupPanel
            title={chooseTitle}
            body={chooseBody}
            progress={requirements.length > 1 ? { done: requirements.length - unmetReqs.length, total: requirements.length } : undefined}
            account={conn}
            requirements={requirements}
            unmetReqs={unmetReqs}
            bindings={bindingFor}
            onPick={pickForRequirement}
            tech={requirements}
          />
        );
      }

      case "picking":
        return (
          <div>
            <SetupPanel
              title={`Choose the ${humanizeAlias(phase.target.alias)} spreadsheet`}
              body={`Select the sheet ${app.slug} should use for ${humanizeAlias(phase.target.alias)}.`}
              account={conn}
              requirements={requirements}
              unmetReqs={unmetReqs}
              bindings={bindingFor}
              onPick={pickForRequirement}
              tech={requirements}
            />
            <MockPicker sheets={MOCK_SHEETS} onSelect={mockSelectSheet} onCancel={cancelPick} />
          </div>
        );

      case "binding":
        return (
          <FocusContent
            icon="spinner"
            title="Connecting your spreadsheet"
            body={`280 is checking access and connecting this spreadsheet for ${humanizeAlias(phase.target.alias)}.`}
            extra={
              <SelectedFileCard file={phase.file} />
            }
            helper="Keep this window open for a moment."
            tech={phase.target}
          />
        );

      case "success":
        return (
          <FocusContent
            icon="success"
            title={`${humanizeAlias(requirements[0]?.alias ?? "Everything")} is ready`}
            body={`${app.slug} can now ${operationsLabel(requirements[0]?.operations ?? [])} in ${bindingsForLabel()}. Any deployment waiting for this spreadsheet can continue.`}
            action={
              <button type="button" className="primary-btn" onClick={close}>
                Done
              </button>
            }
            helper="You can replace this spreadsheet later from Manage Google account."
            tech={requirements[0]}
          />
        );

      case "ready":
        if (requirements.length === 0 && !conn) {
          return (
            <FocusContent
              title="No integrations requested"
              body="This app has no integration requirements in its manifest. Integrations will appear here when the app requests them."
            />
          );
        }
        return (
          <SetupPanel
            title="Google Sheets is ready"
            body={`${app.slug} has every spreadsheet it needs.`}
            account={conn}
            requirements={requirements}
            unmetReqs={[]}
            bindings={bindingFor}
            manage={
              conn ? (
                <ManageAccount
                  connection={conn}
                  requirements={requirements}
                  bindings={bindingFor}
                  busy={busy}
                  onReplace={(req) => pickForRequirement(req)}
                  onDisconnect={() => setPhase({ phase: "confirmDisconnect", connection: conn })}
                />
              ) : undefined
            }
          />
        );

      case "reconnect":
        return (
          <FocusContent
            icon="warning"
            title="Reconnect Google Sheets"
            body={`Google access for ${phase.connection.account} expired. Reconnect to keep ${resourcesLabel(phase.connection)} working for ${app.slug}.`}
            action={
              <GoogleButton onClick={() => reconnect(phase.connection)} disabled={busy}>
                {busy ? "Connecting…" : "Reconnect Google Sheets"}
              </GoogleButton>
            }
            helper="Your spreadsheet choices will stay connected."
            extra={phase.connection.resources.length > 0 && (
              <div className="need-card">
                <SheetsIcon />
                <div>
                  <strong>{resourcesLabel(phase.connection)}</strong>
                  <span>Waiting for Google access</span>
                </div>
              </div>
            )}
          />
        );

      case "error": {
        if (phase.kind === "oauth") {
          return (
            <FocusContent
              error
              title="Google Sheets did not connect"
              body="The connection could not be verified. Try again to choose the Google account for Team inventory."
              action={
                <GoogleButton onClick={() => connect("google")} disabled={busy}>
                  Try Google again
                </GoogleButton>
              }
              helper="If this keeps happening, make sure popups and Google sign in are allowed."
            />
          );
        }
        if (phase.kind === "picker") {
          return (
            <FocusContent
              error
              title="Your spreadsheets could not open"
              body="Google Picker could not be opened. Check your connection, then try again."
              action={
                <button type="button" className="primary-btn" onClick={() => phase.target && pickForRequirement(phase.target)}>
                  Retry
                </button>
              }
              extra={phase.target && (
                <div className="need-card">
                  <SheetsIcon />
                  <div>
                    <strong>{humanizeAlias(phase.target.alias)} spreadsheet</strong>
                    <span>Still waiting for a selection</span>
                  </div>
                </div>
              )}
              helper="You can cancel setup and return later."
            />
          );
        }
        if (phase.kind === "resource") {
          const fileName = phase.file?.name ?? "";
          return (
            <FocusContent
              error
              title={fileName ? `${fileName} is not accessible` : "Spreadsheet is not accessible"}
              body={`The spreadsheet may have been deleted or your access changed. Choose another spreadsheet for ${phase.target ? humanizeAlias(phase.target.alias) : "this need"}.`}
              action={
                <button type="button" className="primary-btn" onClick={() => phase.target && pickForRequirement(phase.target)}>
                  Choose another spreadsheet
                </button>
              }
              extra={
                <div className="inline-alert" role="alert">
                  {fileName ? `${fileName} could not be verified. No binding was changed.` : "The spreadsheet could not be verified. Choose another."}
                </div>
              }
              helper="The setup remains incomplete."
            />
          );
        }
        // platform
        return (
          <FocusContent
            error
            title="Something went wrong"
            body={error ?? "An unexpected error occurred. Please try again."}
            action={
              <button type="button" className="primary-btn" onClick={close}>
                Close
              </button>
            }
          />
        );
      }

      case "confirmDisconnect":
        return (
          <FocusContent
            warningBox
            title="Disconnect Google Sheets?"
            body={`This disconnects ${phase.connection.account} and removes every spreadsheet connected through this account.`}
            extra={
              <div className="confirm-card">
                <strong>{app.slug} will lose access to {resourcesLabel(phase.connection)}.</strong>
                <p>Integration calls will fail. Future deployments will wait until Google Sheets is connected again.</p>
                <div className="confirm-actions">
                  <button type="button" className="secondary-btn" onClick={() => setPhase(derivePhase(data!, false, false))}>
                    Cancel
                  </button>
                  <button type="button" className="danger-btn" onClick={() => disconnectConn(phase.connection)} disabled={busy}>
                    {busy ? "Disconnecting…" : "Disconnect Google Sheets"}
                  </button>
                </div>
              </div>
            }
            helper="This action cannot be undone automatically."
          />
        );
    }
  }

  function bindingsForLabel(): string {
    const bound = requirements.map((r) => bindingFor(r)?.resource.displayName).filter(Boolean);
    if (bound.length === 0) return "the selected spreadsheet";
    return bound.join(", ");
  }

  function resourcesLabel(connection: IntegrationConnection): string {
    if (connection.resources.length === 0) return "your spreadsheets";
    return connection.resources.map((r) => r.displayName).join(", ");
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openDialog}
        className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]"
      >
        <PlugIcon />
        Integrations
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(10,10,10,0.66)] px-6 py-[68px] backdrop-blur-[1px]"
            onClick={(event) => event.target === event.currentTarget && close()}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              className="w-full max-w-[560px] rounded-[18px] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[0_24px_70px_-18px_rgba(10,10,10,0.55)] overflow-hidden"
            >
              <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-4">
                <span id={headingId} className="min-w-0 text-[11px] font-semibold text-[var(--color-muted)]">
                  Google Sheets setup for {app.slug}
                </span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close integrations"
                  className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)]"
                >
                  <CloseIcon />
                </button>
              </div>

              <div className="px-6 pb-6">
                <div aria-live="polite" id={liveRegionId} className="sr-only" />
                {renderPhase()}
              </div>

              {error && <p role="alert" className="mx-6 mb-4 text-[13px] text-[#b4342b]">{error}</p>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function FocusContent({
  icon,
  title,
  body,
  action,
  helper,
  extra,
  tech,
  error,
  warningBox,
}: {
  icon?: "provider" | "success" | "warning" | "spinner";
  title: string;
  body: string;
  action?: React.ReactNode;
  helper?: string;
  extra?: React.ReactNode;
  tech?: IntegrationRequirement | IntegrationRequirement[];
  error?: boolean;
  warningBox?: boolean;
}) {
  return (
    <div className={`focus-content${error ? " error" : ""}${warningBox ? " warning" : ""}`}>
      {icon === "provider" && (
        <div className="provider-icon">
          <SheetsIconLarge />
        </div>
      )}
      {icon === "success" && <div className="success-icon">✓</div>}
      {icon === "warning" && <div className="warning-icon">!</div>}
      {icon === "spinner" && <Spinner />}
      <h4>{title}</h4>
      <p className="body-copy">{body}</p>
      {extra}
      {action}
      {helper && <p className="helper">{helper}</p>}
      {tech && <TechnicalDetails reqs={Array.isArray(tech) ? tech : [tech]} />}
    </div>
  );
}

function TechnicalDetails({ reqs }: { reqs: IntegrationRequirement[] }) {
  return (
    <details className="tech">
      <summary>Technical details</summary>
      {reqs.map((req) => (
        <p key={`${req.capability}:${req.alias}`}>
          Alias: {req.alias}<br />
          Capability: {req.capability}<br />
          Operations: {req.operations.join(", ")}
        </p>
      ))}
    </details>
  );
}

function SetupPanel({
  title,
  body,
  progress,
  account,
  requirements,
  unmetReqs,
  bindings,
  manage,
  onPick,
  tech,
}: {
  title: string;
  body: string;
  progress?: { done: number; total: number };
  account: IntegrationConnection | null;
  requirements: IntegrationRequirement[];
  unmetReqs: IntegrationRequirement[];
  bindings: (req: IntegrationRequirement) => { connection: IntegrationConnection; resource: IntegrationResource } | null;
  manage?: React.ReactNode;
  onPick?: (req: IntegrationRequirement) => void;
  tech?: IntegrationRequirement[];
}) {
  const unmetSet = new Set(unmetReqs.map((r) => `${r.capability}:${r.alias}`));
  return (
    <div className="setup-panel">
      {account && (
        <div className="account-line">
          <SheetsIconSmall />
          <span className="status-dot" />
          <strong>Google Sheets connected</strong>
          <span>{account.account}</span>
        </div>
      )}
      <h4>{title}</h4>
      <p>{body}</p>
      {progress && (
        <>
          <div className="progress-line">
            <strong>{progress.done} of {progress.total} ready</strong>
            <span>{progress.done > 0 ? `${Object.values(requirements.filter((r) => bindings(r))).length} connected` : ""}</span>
          </div>
          <div className="progress-track">
            <div className="progress-value" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </>
      )}
      <div className="needs">
        {requirements.map((req) => {
          const binding = bindings(req);
          const isUnmet = unmetSet.has(`${req.capability}:${req.alias}`);
          const isNext = unmetReqs.length > 0 && unmetReqs[0] === req;
          return (
            <div key={`${req.capability}:${req.alias}`} className={`requirement-card${isNext ? " active" : ""}`}>
              <SheetsIconSmall />
              <div>
                <strong>{humanizeAlias(req.alias)} spreadsheet</strong>
                <span>
                  {binding
                    ? `${binding.resource.displayName} · ${operationsLabel(req.operations)}`
                    : operationsLabel(req.operations)}
                </span>
              </div>
              {isUnmet ? (
                isNext ? (
                  <button type="button" className="row-button primary-action" onClick={() => onPick?.(req)}>
                    Choose spreadsheet
                  </button>
                ) : (
                  <span className="waiting-pill">Waiting</span>
                )
              ) : (
                <span className="ready-pill">✓ Ready</span>
              )}
            </div>
          );
        })}
      </div>
      {manage}
      {tech && <TechnicalDetails reqs={tech} />}
    </div>
  );
}

function ManageAccount({
  connection,
  requirements,
  bindings,
  busy,
  onReplace,
  onDisconnect,
}: {
  connection: IntegrationConnection;
  requirements: IntegrationRequirement[];
  bindings: (req: IntegrationRequirement) => { connection: IntegrationConnection; resource: IntegrationResource } | null;
  busy: boolean;
  onReplace: (req: IntegrationRequirement) => void;
  onDisconnect: () => void;
}) {
  return (
    <details className="manage-box">
      <summary>Manage Google account</summary>
      <div className="manage-actions">
        {requirements.map((req) => {
          const binding = bindings(req);
          if (!binding) return null;
          return (
            <div key={`${req.capability}:${req.alias}`} className="manage-row">
              <div>
                <strong>{binding.resource.displayName}</strong>
                <span>Used for {humanizeAlias(req.alias)}</span>
              </div>
              <button type="button" className="text-action" onClick={() => onReplace(req)} disabled={busy}>
                Replace
              </button>
            </div>
          );
        })}
        <div className="manage-row">
          <div>
            <strong>{connection.account}</strong>
            <span>Connected Google account</span>
          </div>
          <button type="button" className="text-action danger" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </button>
        </div>
      </div>
    </details>
  );
}

function MockPicker({
  sheets,
  onSelect,
  onCancel,
}: {
  sheets: PickedSheet[];
  onSelect: (sheet: PickedSheet) => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper-warm)] p-3">
      <p className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Pick a spreadsheet
      </p>
      {sheets.map((sheet) => (
        <button
          key={sheet.id}
          type="button"
          onClick={() => onSelect(sheet)}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] text-[var(--color-body)] transition-colors hover:bg-[var(--color-paper)]"
        >
          <SheetsIcon />
          {sheet.name}
        </button>
      ))}
      <button
        type="button"
        onClick={onCancel}
        className="mt-1 cursor-pointer rounded-md px-2.5 py-1.5 text-[12.5px] font-semibold text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
      >
        Cancel
      </button>
    </div>
  );
}

function GoogleButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="primary-btn google primary-action"
      onClick={onClick}
      disabled={disabled}
    >
      <SheetsIconSmall />
      {children}
    </button>
  );
}

function SelectedFileCard({ file }: { file: PickedSheet }) {
  return (
    <div className="selected-file">
      <SheetsIcon />
      <div>
        <strong>{file.name}</strong>
        <span>Selected from Google Drive</span>
      </div>
      <Spinner />
    </div>
  );
}

function Spinner({ label }: { label?: string }) {
  return <div className="loading-ring" aria-label={label ?? "Loading"} role="status" />;
}

function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[15px] w-[15px]">
      <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v6" />
    </svg>
  );
}

function SheetsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[18px] w-[18px] shrink-0 text-[var(--color-muted)]">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 9h16M4 15h16M10 9v12M15 9v12" />
    </svg>
  );
}

function SheetsIconLarge() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[47px] w-[47px] shrink-0 text-[var(--color-muted)]">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 9h16M4 15h16M10 9v12M15 9v12" />
    </svg>
  );
}

function SheetsIconSmall() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[18px] w-[18px] shrink-0 text-[var(--color-muted)]">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 9h16M4 15h16M10 9v12M15 9v12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="h-4 w-4">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}