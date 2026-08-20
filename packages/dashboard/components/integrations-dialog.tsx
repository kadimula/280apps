"use client";

// This dialog bridges render state into imperatively-added DOM listeners (the escape
// handler and body scroll-lock) through synced refs instead of useEffect, which this
// package forbids (see CLAUDE.md). That reading of refs during render is what this
// React Compiler rule flags, so it is turned off for this intentional pattern; every
// other rule stays on.
/* eslint-disable react-hooks/refs */

import { type MutableRefObject, useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openGooglePicker } from "@/lib/google-picker";
import {
  type IntegrationCatalog,
  type IntegrationConnection,
  type IntegrationSlot,
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
  | { phase: "choose"; unmetCount: number; afterCancel?: boolean }
  | { phase: "picking"; target: IntegrationSlot; connectionId: string }
  | { phase: "binding"; file: PickedSheet; target: IntegrationSlot }
  | { phase: "success" }
  | { phase: "ready" }
  | { phase: "reconnect"; connection: IntegrationConnection }
  | { phase: "error"; kind: ErrorKind; target?: IntegrationSlot; file?: PickedSheet }
  | { phase: "confirmDisconnect"; connection: IntegrationConnection };

function humanizeAlias(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1).replace(/[-_]/g, " ");
}

type OAuthOutcome = { ok: boolean } | { closed: true };

function openCenteredPopup(url: string, name: string): Window | null {
  const w = 520;
  const h = 640;
  const left = (window.screenLeft ?? window.screenX) + (window.innerWidth - w) / 2;
  const top = (window.screenTop ?? window.screenY) + (window.innerHeight - h) / 2;
  return window.open(url, name, `popup,width=${w},height=${h},left=${Math.max(left, 0)},top=${Math.max(top, 0)}`);
}

// Resolves when the popup posts its result back (via the /oauth/complete page) or
// the user closes it. Both listeners are torn down on the first to fire.
function awaitPopupOutcome(popup: Window): Promise<OAuthOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: OAuthOutcome) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as { type?: string; ok?: boolean } | null;
      if (payload?.type !== "280-oauth-complete") return;
      try { popup.close(); } catch { /* cross-origin during redirect; ignore */ }
      finish({ ok: payload.ok === true });
    };
    window.addEventListener("message", onMessage);
    const poll = setInterval(() => {
      if (popup.closed) finish({ closed: true });
    }, 400);
  });
}

function operationsLabel(ops: string[]): string {
  if (ops.length === 0) return "";
  const human: Record<string, string> = { read: "read", append: "add rows", update: "update", deleteRows: "delete rows" };
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
  hideTrigger = false,
  controllerRef,
  onCatalogChange,
}: {
  app: { id: string; slug: string };
  apiBase: string;
  mock: boolean;
  autoOpen?: boolean;
  oauthError?: boolean;
  // When the dialog is opened from another surface (the settings sidebar) the
  // built-in trigger is suppressed and open() is published through this ref.
  hideTrigger?: boolean;
  controllerRef?: MutableRefObject<{ open: () => void } | null>;
  // Publishes every fresh catalog read so surfaces outside the dialog (the
  // settings sidebar and header badge) reflect binds and disconnects live.
  onCatalogChange?: (catalog: IntegrationCatalog) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<IntegrationCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<PhaseState>({ phase: "loading" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const liveRegionId = useId();

  const refresh = useCallback(async (): Promise<IntegrationCatalog | null> => {
    const result = await listIntegrations(app.id);
    if ("error" in result) {
      setError(result.error);
      setData((current) => current ?? { providers: [], connections: [], slots: [] });
      return null;
    }
    setData(result);
    onCatalogChange?.(result);
    return result;
  }, [app.id, onCatalogChange]);

  function derivePhase(catalog: IntegrationCatalog, oauthFailed: boolean): PhaseState {
    const slots = catalog.slots;
    const conn = catalog.connections[0] ?? null;

    if (oauthFailed) return { phase: "error", kind: "oauth" };

    if (!conn && slots.length === 0) return { phase: "ready" };

    if (!conn) return { phase: "connect" };

    if (conn.status === "reauthorization_required") return { phase: "reconnect", connection: conn };

    const unmet = slots.filter((s) => s.binding === null);

    if (unmet.length === 0) {
      return { phase: slots.length > 0 ? "ready" : "success" };
    }

    return { phase: "choose", unmetCount: unmet.length };
  }

  function openDialog() {
    setOpen(true);
    setPhase({ phase: "loading" });
    document.body.style.overflow = "hidden";
    refresh().then((catalog) => {
      if (catalog) setPhase(derivePhase(catalog, oauthError));
    });
  }

  function close() {
    setOpen(false);
    setData(null);
    setError(null);
    setBusy(false);
    setPhase({ phase: "loading" });
    document.body.style.overflow = "";
    triggerRef.current?.focus();
  }

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const dataRef = useRef(data);
  dataRef.current = data;
  const cancelPickRef = useRef(cancelPick);
  cancelPickRef.current = cancelPick;
  const closeRef = useRef(close);
  closeRef.current = close;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const oauthErrorRef = useRef(oauthError);
  oauthErrorRef.current = oauthError;

  const escapeHandlerRef = useRef((event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const p = phaseRef.current;
    const d = dataRef.current;
    if (p.phase === "confirmDisconnect") { setPhase(derivePhase(d!, false)); return; }
    if (p.phase === "picking") { cancelPickRef.current(); return; }
    if (p.phase === "success" || p.phase === "ready") { closeRef.current(); return; }
    if (p.phase === "error" && p.kind === "resource") {
      setPhase({ phase: "choose", unmetCount: 1 });
      return;
    }
    closeRef.current();
  });

  const autoOpenTriggeredRef = useRef(false);

  const dialogOverlayRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", escapeHandlerRef.current);
      return;
    }
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", escapeHandlerRef.current);
  }, []);

  const triggerRefCallback = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el;
  }, []);

  // The autoOpen deep link fires from an always-mounted sentinel rather than the
  // trigger button, so hiding the trigger (sidebar-driven open) still honors it.
  const autoOpenMountRef = useCallback((el: HTMLElement | null) => {
    if (!el || !autoOpen || autoOpenTriggeredRef.current) return;
    autoOpenTriggeredRef.current = true;

    setOpen(true);
    setPhase({ phase: "loading" });
    document.body.style.overflow = "hidden";

    refreshRef.current().then((catalog) => {
      if (catalog) setPhase(derivePhase(catalog, oauthErrorRef.current));
    });
    // Runs once on mount to honor the autoOpen deep link; later autoOpen changes must not re-fire it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (controllerRef) controllerRef.current = { open: openDialog };

  async function connect(provider: string) {
    if (mock) {
      setBusy(true);
      setError(null);
      const failure = await mockConnect(app.id, provider);
      if (failure) {
        setError(failure.error);
      } else {
        const catalog = await refresh();
        if (catalog) setPhase(derivePhase(catalog, false));
      }
      setBusy(false);
      return;
    }
    const startUrl = (returnPath: string) =>
      `${apiBase}/internal/apps/${encodeURIComponent(app.id)}/integrations/${encodeURIComponent(provider)}/start?redirect=${encodeURIComponent(returnPath)}`;

    const popup = openCenteredPopup(startUrl("/oauth/complete"), "280-oauth");
    if (!popup) {
      // Popup blocked: fall back to the full-page redirect, which returns to the
      // dashboard deep link and resumes through the autoOpen path.
      window.location.assign(startUrl(`/dashboard/${app.id}?integrations=1`));
      return;
    }

    setBusy(true);
    setError(null);
    const outcome = await awaitPopupOutcome(popup);
    setBusy(false);
    // A severed opener (COOP) can drop the postMessage, so a bare close is not a
    // failure: re-read the catalog and let derivePhase advance to the picker step
    // if the exchange actually landed. Only an explicit ok:false is a real failure.
    if ("ok" in outcome && !outcome.ok) {
      setPhase({ phase: "error", kind: "oauth" });
      return;
    }
    const catalog = await refresh();
    if (catalog) setPhase(derivePhase(catalog, false));
  }

  async function startPick(connection: IntegrationConnection, target: IntegrationSlot) {
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
    } catch {
      setPhase({ phase: "error", kind: "picker", target });
    }
  }

  function cancelPick() {
    const derived = data ? derivePhase(data, false) : { phase: "connect" as const };
    setPhase(derived.phase === "choose" ? { ...derived, afterCancel: true } : derived);
  }

  function pickForRequirement(slot: IntegrationSlot) {
    const conn = data?.connections[0];
    if (!conn) return;
    void startPick(conn, slot);
  }

  function mockSelectSheet(sheet: PickedSheet) {
    if (phase.phase !== "picking") return;
    bindResource(sheet, phase.target);
  }

  async function bindResource(file: PickedSheet, target: IntegrationSlot) {
    const conn = data?.connections[0];
    if (!conn) return;
    setPhase({ phase: "binding", file, target });
    setError(null);
    const result = await registerResource(app.id, conn.id, target.capability, target.alias, file.id);
    if ("error" in result) {
      setPhase({ phase: "error", kind: "resource", target, file });
    } else {
      const catalog = await refresh();
      if (catalog) {
        const derived = derivePhase(catalog, false);
        setPhase(derived.phase === "ready" ? { phase: "success" } : derived);
      }
    }
    setBusy(false);
  }

  async function disconnectConn(connection: IntegrationConnection) {
    setBusy(true);
    setError(null);
    setPhase({ phase: "loading" });
    const failure = await disconnectConnection(app.id, connection.id);
    if (failure) {
      setError(failure.error);
    } else {
      const catalog = await refresh();
      if (catalog) setPhase(derivePhase(catalog, false));
    }
    setBusy(false);
  }

  function reconnect(connection: IntegrationConnection) {
    void connect(connection.provider);
  }

  const conn = data?.connections[0] ?? null;
  const slots = data?.slots ?? [];
  const unmetSlots = slots.filter((s) => s.binding === null);

  function renderPhase() {
    switch (phase.phase) {
      case "loading":
        return (
          <FocusContent
            icon="spinner"
            title="Getting Google Sheets ready"
            body={`Checking what ${app.slug} needs and whether Google is already connected.`}
          />
        );

      case "connect":
        return (
          <FocusContent
            icon="provider"
            title="Connect Google Sheets"
            body={`${app.slug} needs a spreadsheet for ${humanizeAlias(unmetSlots[0]?.alias ?? "data")}. Connect Google to choose it next.`}
            action={
              <GoogleButton onClick={() => connect("google")} disabled={busy}>
                {busy ? "Connecting…" : "Connect Google Sheets"}
              </GoogleButton>
            }
          />
        );

      case "choose": {
        if (unmetSlots.length === 1) {
          const slot = unmetSlots[0];
          const alias = humanizeAlias(slot.alias);
          return (
            <FocusContent
              icon="provider"
              banner={conn && <ConnectedBanner />}
              title={
                phase.afterCancel
                  ? `No spreadsheet was selected. Choose the sheet we should use for ${alias}.`
                  : `Please choose the sheet we should use for ${alias}.`
              }
              action={
                <button
                  type="button"
                  className="primary-btn primary-action"
                  onClick={() => pickForRequirement(slot)}
                  disabled={busy}
                  autoFocus
                >
                  {busy ? "Opening…" : "Choose spreadsheet"}
                </button>
              }
            />
          );
        }
        return (
          <SetupPanel
            title={`Choose ${unmetSlots.length} more spreadsheets`}
            body={`${app.slug} needs a separate spreadsheet for each job.`}
            progress={slots.length > 1 ? { done: slots.length - unmetSlots.length, total: slots.length } : undefined}
            account={conn}
            slots={slots}
            unmetSlots={unmetSlots}
            onPick={pickForRequirement}
          />
        );
      }

      case "picking":
        return (
          <FocusContent
            icon="provider"
            title={`Choose the ${humanizeAlias(phase.target.alias)} spreadsheet`}
            body={`Select the sheet ${app.slug} should use for ${humanizeAlias(phase.target.alias)}.`}
            extra={<MockPicker sheets={MOCK_SHEETS} onSelect={mockSelectSheet} onCancel={cancelPick} />}
          />
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
          />
        );

      case "success":
        return (
          <FocusContent
            icon="success"
            title={`${humanizeAlias(slots[0]?.alias ?? "Everything")} is ready`}
            body={`This app can now ${operationsLabel(slots[0]?.operations ?? [])} in ${bindingsForLabel()}.`}
            action={
              <button type="button" className="primary-btn" onClick={close} autoFocus>
                Done
              </button>
            }
          />
        );

      case "ready":
        if (slots.length === 0 && !conn) {
          return (
            <FocusContent
              title="No integrations requested"
              body="This app has no integration requirements in its manifest. Integrations will appear here when the app requests them."
            />
          );
        }
        return (
          <ReadyPanel
            appSlug={app.slug}
            connection={conn!}
            slots={slots}
            busy={busy}
            onReplace={(slot) => pickForRequirement(slot)}
            onDisconnect={() => setPhase({ phase: "confirmDisconnect", connection: conn! })}
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
                <button type="button" className="primary-btn" onClick={() => phase.target && pickForRequirement(phase.target)} autoFocus>
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
                <button type="button" className="primary-btn" onClick={() => phase.target && pickForRequirement(phase.target)} autoFocus>
                  Choose another spreadsheet
                </button>
              }
              extra={
                <div className="inline-alert" role="alert">
                  {fileName ? `${fileName} could not be verified. No binding was changed.` : "The spreadsheet could not be verified. Choose another."}
                </div>
              }
            />
          );
        }
        return (
          <FocusContent
            error
            title="Something went wrong"
            body={error ?? "An unexpected error occurred. Please try again."}
            action={
              <button type="button" className="primary-btn" onClick={close} autoFocus>
                Close
              </button>
            }
          />
        );
      }

      case "confirmDisconnect":
        return (
          <FocusContent
            icon="warning"
            title="Disconnect Google Sheets?"
            body={`${app.slug} will lose access to ${resourcesLabel(phase.connection)} and integration calls will fail until you reconnect ${phase.connection.account}.`}
            action={
              <div className="confirm-actions">
                <button type="button" className="secondary-btn" onClick={() => setPhase(derivePhase(data!, false))}>
                  Cancel
                </button>
                <button type="button" className="danger-btn" onClick={() => disconnectConn(phase.connection)} disabled={busy}>
                  {busy ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            }
          />
        );
    }
  }

  function bindingsForLabel(): string {
    const bound = slots.map((s) => s.binding?.displayName).filter(Boolean);
    if (bound.length === 0) return "the selected spreadsheet";
    return bound.join(", ");
  }

  function resourcesLabel(connection: IntegrationConnection): string {
    if (connection.resources.length === 0) return "your spreadsheets";
    return connection.resources.map((r) => r.displayName).join(", ");
  }

  return (
    <>
      <span ref={autoOpenMountRef} hidden aria-hidden />
      {!hideTrigger && (
        <button
          ref={triggerRefCallback}
          type="button"
          onClick={openDialog}
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]"
        >
          <PlugIcon />
          Integrations
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={dialogOverlayRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,10,10,0.66)] px-6 py-[68px] backdrop-blur-[1px]"
            onClick={(event) => event.target === event.currentTarget && close()}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              className="flex max-h-full min-h-[340px] w-full max-w-[420px] flex-col rounded-[18px] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[0_24px_70px_-18px_rgba(10,10,10,0.55)] overflow-hidden"
            >
              <div className="flex flex-1 flex-col justify-center overflow-y-auto px-7 py-7">
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
  banner,
  title,
  body,
  action,
  extra,
  error,
}: {
  icon?: "provider" | "success" | "warning" | "spinner";
  banner?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
  extra?: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div className={`focus-content${error ? " error" : ""}`}>
      {banner}
      {icon === "provider" && (
        <div className="provider-icon">
          <SheetsIconLarge />
        </div>
      )}
      {icon === "success" && <div className="success-icon">✓</div>}
      {icon === "warning" && <div className="warning-icon">!</div>}
      {icon === "spinner" && <Spinner />}
      <h4>{title}</h4>
      {body && <p className="body-copy">{body}</p>}
      {extra}
      {action}
    </div>
  );
}

function SetupPanel({
  title,
  body,
  progress,
  account,
  slots,
  unmetSlots,
  onPick,
}: {
  title: string;
  body: string;
  progress?: { done: number; total: number };
  account: IntegrationConnection | null;
  slots: IntegrationSlot[];
  unmetSlots: IntegrationSlot[];
  onPick?: (slot: IntegrationSlot) => void;
}) {
  const unmetSet = new Set(unmetSlots.map((s) => `${s.capability}:${s.alias}`));
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
            <span>{progress.done > 0 ? `${slots.filter((s) => s.binding).length} connected` : ""}</span>
          </div>
          <div className="progress-track">
            <div className="progress-value" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </>
      )}
      <div className="needs">
        {slots.map((slot) => {
          const binding = slot.binding;
          const isUnmet = unmetSet.has(`${slot.capability}:${slot.alias}`);
          const isNext = unmetSlots.length > 0 && unmetSlots[0] === slot;
          return (
            <div key={`${slot.capability}:${slot.alias}`} className={`requirement-card${isNext ? " active" : ""}`}>
              <SheetsIconSmall />
              <div>
                <strong>{humanizeAlias(slot.alias)} spreadsheet</strong>
                <span>
                  {binding
                    ? `${binding.displayName} · ${operationsLabel(slot.operations)}`
                    : operationsLabel(slot.operations)}
                </span>
              </div>
              {isUnmet ? (
                isNext ? (
                  <button type="button" className="row-button primary-action" onClick={() => onPick?.(slot)}>
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
    </div>
  );
}

function ReadyPanel({
  appSlug,
  connection,
  slots,
  busy,
  onReplace,
  onDisconnect,
}: {
  appSlug: string;
  connection: IntegrationConnection;
  slots: IntegrationSlot[];
  busy: boolean;
  onReplace: (slot: IntegrationSlot) => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="ready-panel">
      <div className="ready-head">
        <span className="ready-check" aria-hidden>✓</span>
        <div>
          <h4>Google Sheets is ready</h4>
          <p>{appSlug} has every spreadsheet it needs.</p>
        </div>
      </div>
      <div className="ready-sheets">
        {slots.map((slot) => (
          <div key={`${slot.capability}:${slot.alias}`} className="sheet-row">
            <SheetsIconSmall />
            <div className="sheet-meta">
              <strong>{slot.binding?.displayName ?? `${humanizeAlias(slot.alias)} spreadsheet`}</strong>
              <span>{humanizeAlias(slot.alias)} · {operationsLabel(slot.operations)}</span>
            </div>
            <button type="button" className="ghost-btn" onClick={() => onReplace(slot)} disabled={busy}>
              Replace
            </button>
          </div>
        ))}
      </div>
      <div className="ready-account">
        <span className="acct-dot" aria-hidden />
        <span className="acct-email">{connection.account}</span>
        <button type="button" className="link-danger" onClick={onDisconnect} disabled={busy}>
          Disconnect
        </button>
      </div>
    </div>
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

function ConnectedBanner() {
  return (
    <div className="mb-2 flex items-center gap-2.5">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#18864b] text-[19px] font-bold text-white"
        aria-hidden
      >
        ✓
      </span>
      <strong className="text-[17px] font-semibold text-[#14683c]">Google Sheets connected</strong>
    </div>
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