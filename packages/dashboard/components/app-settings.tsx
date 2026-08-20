"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type MutableRefObject,
  type ReactNode,
  useContext,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";

import { deleteAppAction } from "@/app/dashboard/actions";
import { IntegrationsDialog } from "@/components/integrations-dialog";
import { VariablesPanel } from "@/components/variables-panel";
import type { AppStatus } from "@/lib/apps";
import { type IntegrationSummary, integrationSummary } from "@/lib/integration-summary";
import type { IntegrationCatalog, IntegrationSlot } from "@/lib/integrations";

const CONFIRM_WORD = "delete";

// A per-app settings surface: an icon button in the header toggles a sidebar that
// sits below the top bar and to the right of the app frame. The frame is a flex
// sibling with flex-1, so opening the panel squishes it rather than covering it.
// Button and panel live in different parts of the page tree, so open state is
// shared through this context rather than lifted into the server component.

type IntegrationsController = { open: () => void } | null;

const SettingsContext = createContext<{
  open: boolean;
  toggle: () => void;
  close: () => void;
  // The integrations dialog is a page-level modal; the sidebar button opens it
  // through this shared handle rather than owning the dialog itself.
  integrationsRef: MutableRefObject<IntegrationsController>;
  // The live catalog is the single source the sidebar, header badge, and dialog
  // all read, so a bind or disconnect inside the dialog is reflected everywhere
  // without a full-page reload.
  catalog: IntegrationCatalog | null;
  setCatalog: (catalog: IntegrationCatalog) => void;
} | null>(null);

function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

export function SettingsProvider({
  children,
  defaultOpen = false,
  initialCatalog = null,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  initialCatalog?: IntegrationCatalog | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [catalog, setCatalog] = useState<IntegrationCatalog | null>(initialCatalog);
  const integrationsRef = useRef<IntegrationsController>(null);
  return (
    <SettingsContext.Provider
      value={{
        open,
        toggle: () => setOpen((v) => !v),
        close: () => setOpen(false),
        integrationsRef,
        catalog,
        setCatalog,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

// Mounts the integrations dialog headless at page level and publishes its open()
// to the sidebar. Kept always-mounted so the OAuth-return autoOpen deep link is
// honored even while the sidebar is closed.
export function IntegrationsMount(props: {
  app: { id: string; slug: string };
  apiBase: string;
  mock: boolean;
  autoOpen?: boolean;
  oauthError?: boolean;
}) {
  const { integrationsRef, setCatalog } = useSettings();
  return (
    <IntegrationsDialog
      {...props}
      hideTrigger
      controllerRef={integrationsRef}
      onCatalogChange={setCatalog}
    />
  );
}

export function SettingsButton() {
  const { open, toggle, catalog } = useSettings();
  const needsAttention = integrationSummary(catalog).readiness === "attention";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={needsAttention ? "Settings — integrations need attention" : "Settings"}
      aria-pressed={open}
      className={`relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition-colors ${
        open
          ? "border-[var(--color-ink)] bg-[var(--color-paper-warm)] text-[var(--color-ink)]"
          : "border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] text-[var(--color-ink)] hover:border-[var(--color-ink)]"
      }`}
    >
      <GearIcon />
      {needsAttention && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-[var(--color-paper)] bg-[#b4342b]"
        />
      )}
    </button>
  );
}

const TABS = ["Integrations", "Variables", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function SettingsSidebar({
  status,
  appId,
  slug,
}: {
  status: AppStatus | null;
  appId: string;
  slug: string;
}) {
  const { open, integrationsRef, catalog } = useSettings();
  const integrations = integrationSummary(catalog);
  const [tab, setTab] = useState<Tab>("Integrations");

  // Every fresh open lands on Integrations, regardless of the last tab used.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTab("Integrations");
  }

  return (
    <aside
      aria-hidden={!open}
      className={`min-h-0 shrink-0 overflow-hidden border-l border-[var(--color-line)] bg-[var(--color-paper)] transition-[width] duration-200 ease-out ${
        open ? "w-[320px]" : "w-0"
      }`}
    >
      <div className="flex h-full w-[320px] flex-col">
        <div className="flex shrink-0 border-b border-[var(--color-line)]" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex-1 cursor-pointer border-b-2 px-2 py-3 text-[13px] font-medium transition-colors ${
                tab === t
                  ? "border-[var(--color-ink)] text-[var(--color-ink)]"
                  : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {tab === "Variables" && <VariablesPanel key={appId} app={{ id: appId, slug }} />}
          {tab === "Integrations" && (
            <IntegrationsPanel
              summary={integrations}
              onOpen={() => integrationsRef.current?.open()}
            />
          )}
          {tab === "Settings" && (
            <div className="flex min-h-full flex-col">
              <DeployStatus status={status} />
              <DeleteApp appId={appId} slug={slug} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function slotName(slot: IntegrationSlot): string {
  return slot.alias.charAt(0).toUpperCase() + slot.alias.slice(1).replace(/[-_]/g, " ");
}

// The sidebar's read-only view of what the app requests and whether it is
// connected. The button hands off to the page-level dialog for the actual flow.
function IntegrationsPanel({
  summary,
  onOpen,
}: {
  summary: IntegrationSummary;
  onOpen: () => void;
}) {
  const { readiness, connected, slots, unmet, label } = summary;
  const isSheets = label === "Google Sheets";

  if (readiness === "unknown") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-[1.55] text-[var(--color-body)]">
          Integration status is unavailable right now.
        </p>
        <button type="button" onClick={onOpen} className={SIDEBAR_BUTTON}>
          Open integrations
        </button>
      </div>
    );
  }

  if (readiness === "none") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-[1.55] text-[var(--color-body)]">
          This app requests no integrations. They appear here when the app asks
          for one in its manifest.
        </p>
      </div>
    );
  }

  const allReady = readiness === "ready";
  const action = !connected
    ? `Connect to ${label}`
    : unmet.length > 0
      ? isSheets
        ? "Choose a Google Sheet"
        : `Finish connecting ${label}`
      : `Manage ${label}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {isSheets && <GoogleSheetsIcon />}
            <strong className="truncate text-[13.5px] font-semibold text-[var(--color-ink)]">{label}</strong>
          </span>
          {!connected && <NotConnectedPill />}
        </div>
        {connected ? (
          <div className="flex flex-col gap-1.5">
            {slots.map((slot) =>
              slot.binding ? (
                <div
                  key={`${slot.capability}:${slot.alias}`}
                  className="flex items-baseline justify-between gap-2 text-[12.5px]"
                >
                  <span className="text-[var(--color-body)]">{slotName(slot)}</span>
                  <span className="truncate text-right text-[var(--color-muted)]">
                    {slot.binding.displayName}
                  </span>
                </div>
              ) : (
                <p
                  key={`${slot.capability}:${slot.alias}`}
                  className="text-[12.5px] leading-[1.55] font-medium text-[#b4342b]"
                >
                  Select a sheet to connect to the slot: {slotName(slot)}
                </p>
              ),
            )}
          </div>
        ) : (
          <p className="text-[12.5px] leading-[1.55] text-[var(--color-body)]">
            Click the button below to connect your data securely in a few clicks.
          </p>
        )}
      </div>

      <button type="button" onClick={onOpen} className={allReady ? SIDEBAR_BUTTON : SIDEBAR_PRIMARY_BUTTON}>
        {action}
      </button>
    </div>
  );
}

const SIDEBAR_BUTTON =
  "w-full cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper-warm)] px-4 py-2.5 text-[13px] font-semibold text-[var(--color-ink)] transition-colors hover:border-[var(--color-ink)]";

const SIDEBAR_PRIMARY_BUTTON =
  "w-full cursor-pointer rounded-lg bg-[var(--color-ink)] px-4 py-2.5 text-[13px] font-semibold text-[var(--color-paper)] transition-opacity hover:opacity-90";

function GoogleSheetsIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className="h-[18px] w-[18px] shrink-0">
      <path fill="#0F9D58" d="M29 3H11a3 3 0 0 0-3 3v36a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V14L29 3Z" />
      <path fill="#0C7C43" d="M29 3v8a3 3 0 0 0 3 3h8L29 3Z" />
      <path
        fill="#F1F1F1"
        d="M16 22h16v14H16V22Zm2 2v3h5v-3h-5Zm7 0v3h5v-3h-5Zm-7 5v3h5v-3h-5Zm7 0v3h5v-3h-5Z"
      />
    </svg>
  );
}

function NotConnectedPill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#b4342b]/10 px-2 py-0.5 text-[11px] font-semibold text-[#b4342b]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#b4342b]" />
      Not connected
    </span>
  );
}

function DeployStatus({ status }: { status: AppStatus | null }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Deploy status
      </span>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-[var(--color-ink)]">
        {JSON.stringify(status, null, 2)}
      </pre>
    </div>
  );
}

// Deleting asks the human to type "delete". The dialog names the app, which is
// the part `two80 delete --yes <name>` has to get from a command line. The button
// unlocking is a courtesy; the platform checks the word regardless.
function DeleteApp({ appId, slug }: { appId: string; slug: string }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const headingId = useId();

  function close() {
    setConfirming(false);
    setTyped("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await deleteAppAction(appId, typed);
      // The app this page was about is gone; return to the list (which the
      // action has already revalidated).
      if (result?.error) setError(result.error);
      else router.push("/dashboard");
    });
  }

  const armed = typed.trim().toLowerCase() === CONFIRM_WORD;

  return (
    <div className="mt-auto border-t border-[var(--color-line)] pt-5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Danger zone
      </span>
      <p className="mt-2 text-[13px] leading-[1.55] text-[var(--color-body)]">
        Deleting removes the app, its URL, and its data for good.
      </p>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="mt-3 w-full cursor-pointer rounded-lg border border-[#b4342b]/40 px-4 py-2.5 text-[13px] font-medium text-[#b4342b] transition-colors hover:bg-[#b4342b]/8"
      >
        Delete app
      </button>

      {/* Portalled: the dashboard's header outranks main in the stacking order,
          so an overlay rendered in place would sit under it. */}
      {confirming &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,10,10,0.32)] px-6"
            onClick={(event) => {
              if (event.target === event.currentTarget && !pending) close();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !pending) close();
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
                  autoFocus
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

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-4 w-4"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
