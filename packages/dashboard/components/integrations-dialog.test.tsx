// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationsDialog } from "@/components/integrations-dialog";
import {
  listIntegrations,
  mockConnect,
  registerResource,
  selectorSession,
} from "@/lib/integrations";
import { setMockReauth, setMockSelectorFail, setMockValidationFail } from "@/lib/mock-backend";

vi.mock("@/lib/integrations", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/integrations")>();
  return {
    ...original,
    listIntegrations: vi.fn(),
    mockConnect: vi.fn(),
    registerResource: vi.fn(),
    selectorSession: vi.fn(),
    disconnect: vi.fn(),
    removeResource: vi.fn(),
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const app = { id: "app_1af8df68e0f6", slug: "sheets-todo" };
const provider = { provider: "google", capabilities: ["google-sheets"] };

type Conn = {
  id: string;
  provider: string;
  status: "active" | "reauthorization_required";
  account: string;
  updatedAt: number;
  resources: { id: string; capability: string; alias: string; displayName: string }[];
};
type Req = { alias: string; capability: string; operations: string[] };

const ordersReq: Req = { alias: "orders", capability: "google-sheets", operations: ["read", "append"] };
const inventoryReq: Req = { alias: "inventory", capability: "google-sheets", operations: ["read", "write"] };
const returnsReq: Req = { alias: "returns", capability: "google-sheets", operations: ["read"] };

// The server resolves each requirement to a slot by the alias↔resource join; the
// dialog reads slot.binding directly. These fixtures build the same shape the backend
// hands the dialog, so the test never re-derives the join client-side.
function slotsFrom(reqs: Req[], conns: Conn[]) {
  return reqs.map((r) => {
    for (const c of conns) {
      const res = c.resources.find((x) => x.capability === r.capability && x.alias === r.alias);
      if (res) return { ...r, provider: "google", binding: { resourceId: res.id, displayName: res.displayName, connectionId: c.id } };
    }
    return { ...r, provider: "google", binding: null };
  });
}

function catalog({ connections = [], requirements = [] }: { connections?: Conn[]; requirements?: Req[] }) {
  return { providers: [provider], connections, slots: slotsFrom(requirements, connections) };
}

async function openDialog(props?: Partial<Parameters<typeof IntegrationsDialog>[0]>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <IntegrationsDialog app={app} apiBase="" mock autoOpen={false} {...props} />,
    ),
  );
  await act(async () => {
    (host.querySelector("button") as HTMLButtonElement).click();
    await Promise.resolve();
  });
  return { host, root };
}

function dialog() {
  return document.querySelector('[role="dialog"]')!;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.mocked(listIntegrations).mockReset();
  vi.mocked(mockConnect).mockReset();
  vi.mocked(registerResource).mockReset();
  vi.mocked(selectorSession).mockReset();
  setMockReauth(false);
  setMockSelectorFail(false);
  setMockValidationFail(false);
});

describe("IntegrationsDialog", () => {
  it("renders with the deep link autoOpen flag during SSR without portal", () => {
    const html = renderToStaticMarkup(
      <IntegrationsDialog app={app} apiBase="" mock autoOpen />,
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("Integrations");
  });

  it("shows Connect Google Sheets when there are requirements but no connection", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    expect(d.textContent).toContain("Connect Google Sheets");
    expect(d.textContent).toContain("Orders");
    expect(d.textContent).not.toContain("Connected accounts");
    await act(async () => root.unmount());
  });

  it("shows an empty state when the manifest has no requirements", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [],
      requirements: [],
    }));

    const { root } = await openDialog();
    const d = dialog();

    expect(d.textContent).toContain("No integrations requested");
    expect(d.textContent).not.toContain("Connect");
    await act(async () => root.unmount());
  });

  it("hides raw aliases in the primary connect copy", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    // The focus panel names the humanized alias, never the raw manifest values.
    const body = d.querySelector(".body-copy")?.textContent ?? "";
    expect(body).not.toContain("google-sheets");
    expect(body).not.toContain("append");
    await act(async () => root.unmount());
  });

  it("Connect builds OAuth start URL with safe dashboard return path", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();
    const btn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Connect Google Sheets"),
    );
    expect(btn).toBeTruthy();
    await act(async () => root.unmount());
  });

  it("lands on the choose step when autoOpen returns with a connection and unmet requirements", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [],
        },
      ],
      requirements: [ordersReq],
    }));

    // The picker must not open on its own after the OAuth return; a stalled session
    // would surface only if something auto-launched it.
    vi.mocked(selectorSession).mockReturnValue(new Promise(() => {}));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <IntegrationsDialog app={app} apiBase="" mock autoOpen />,
      ),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const d = dialog();
    expect(d).toBeTruthy();
    expect(d.textContent).toContain("Google Sheets connected");
    expect(d.textContent).toContain("choose the sheet we should use for");
    expect(d.textContent).not.toContain("Pick a spreadsheet");
    await act(async () => root.unmount());
  });

  it("opens the picker only after the user clicks choose on the return step", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [],
        },
      ],
      requirements: [ordersReq],
    }));

    vi.mocked(selectorSession).mockResolvedValue({
      accessToken: "mock",
      expiresAt: 9999,
      pickerApiKey: "mock",
      projectNumber: "mock",
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <IntegrationsDialog app={app} apiBase="" mock autoOpen />,
      ),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No picker until the user clicks; the return step waits on a gesture.
    expect(dialog().textContent).not.toContain("Pick a spreadsheet");

    await act(async () => {
      const btn = [...dialog().querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Choose spreadsheet"),
      ) as HTMLButtonElement;
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dialog().textContent).toContain("Pick a spreadsheet");
    await act(async () => root.unmount());
  });

  it("picker cancellation does not register a resource and returns to choose", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [],
        },
      ],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();

    // Manually pick a requirement (click the "Choose spreadsheet" button if visible).
    // Actually, the choose state should have a "Choose spreadsheet" button.
    const d = dialog();
    const pickBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Choose spreadsheet"),
    );
    if (pickBtn) {
      vi.mocked(selectorSession).mockResolvedValue({
        accessToken: "mock",
        expiresAt: 9999,
        pickerApiKey: "mock",
        projectNumber: "mock",
      });
      await act(async () => {
        pickBtn.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    // Now cancel
    const cancelBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Cancel"),
    );
    if (cancelBtn) {
      await act(async () => {
        cancelBtn.click();
        await Promise.resolve();
      });
    }

    expect(registerResource).not.toHaveBeenCalled();
    expect(d.textContent).not.toContain("alert");
    await act(async () => root.unmount());
  });

  it("shows reconnect state when connection needs reauthorization", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "reauthorization_required" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [{ id: "res_1", capability: "google-sheets", alias: "orders", displayName: "Orders 2026" }],
        },
      ],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    expect(d.textContent).toContain("Reconnect Google Sheets");
    expect(d.textContent).toContain("Orders 2026");
    expect(d.textContent).toContain("expired");
    await act(async () => root.unmount());
  });

  it("shows ready summary with inline replace and disconnect", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [{ id: "res_1", capability: "google-sheets", alias: "orders", displayName: "Orders 2026" }],
        },
      ],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    expect(d.textContent).toContain("Google Sheets is ready");
    expect(d.textContent).toContain("Orders 2026");
    const replaceBtn = [...d.querySelectorAll("button")].find((b) => b.textContent?.includes("Replace"));
    const disconnectBtn = [...d.querySelectorAll("button")].find((b) => b.textContent?.includes("Disconnect"));
    expect(replaceBtn).toBeTruthy();
    expect(disconnectBtn).toBeTruthy();
    await act(async () => root.unmount());
  });

  it("shows multiple requirements with correct progress", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [{ id: "res_1", capability: "google-sheets", alias: "orders", displayName: "Orders 2026" }],
        },
      ],
      requirements: [ordersReq, inventoryReq, returnsReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    expect(d.textContent).toContain("1 of 3 ready");
    expect(d.textContent).toContain("Ready");
    expect(d.textContent).toContain("Waiting");
    // The next unmet requirement should have "Choose spreadsheet"
    const buttons = [...d.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("Choose spreadsheet"),
    );
    expect(buttons.length).toBe(1);
    await act(async () => root.unmount());
  });

  it("shows success with Done button after all requirements bound", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [{ id: "res_1", capability: "google-sheets", alias: "orders", displayName: "Orders 2026" }],
        },
      ],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    // Should show ready (all requirements met)
    expect(d.textContent).toContain("Google Sheets is ready");
    await act(async () => root.unmount());
  });

  it("shows disconnect confirmation with consequences", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [{ id: "res_1", capability: "google-sheets", alias: "orders", displayName: "Orders 2026" }],
        },
      ],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    // Click Disconnect (inline on the ready panel)
    const disconnectBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Disconnect"),
    );
    expect(disconnectBtn).toBeTruthy();
    await act(async () => {
      disconnectBtn!.click();
      await Promise.resolve();
    });

    expect(d.textContent).toContain("Disconnect Google Sheets?");
    expect(d.textContent).toContain("will lose access");
    expect(d.textContent).toContain("Orders 2026");
    await act(async () => root.unmount());
  });

  it("Escape closes confirmDisconnect before parent dialog", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [{ id: "res_1", capability: "google-sheets", alias: "orders", displayName: "Orders 2026" }],
        },
      ],
      requirements: [ordersReq],
    }));

    const { root } = await openDialog();
    const d = dialog();

    expect(d.textContent).toContain("Google Sheets is ready");

    // Click Disconnect (inline on the ready panel)
    const disconnectBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Disconnect"),
    );
    await act(async () => { disconnectBtn!.click(); await Promise.resolve(); });

    expect(d.textContent).toContain("Disconnect Google Sheets?");

    // Escape should cancel confirmation but keep dialog open
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });

    expect(d.textContent).not.toContain("Disconnect Google Sheets?");
    expect(d.textContent).toContain("Google Sheets is ready");
    await act(async () => root.unmount());
  });

  it("closing restores focus to Integrations trigger", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [],
      requirements: [ordersReq],
    }));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<IntegrationsDialog app={app} apiBase="" mock />),
    );

    const trigger = host.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="dialog"]')).toBeTruthy();

    // Close via Escape
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="dialog"]')).toBeFalsy();
    expect(document.activeElement).toBe(trigger);
    await act(async () => root.unmount());
  });

  it("shows OAuth error state when oauthError prop is true", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [],
      requirements: [ordersReq],
    }));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <IntegrationsDialog app={app} apiBase="" mock autoOpen oauthError />,
      ),
    );

    const d = dialog();
    expect(d).toBeTruthy();
    expect(d.textContent).toContain("Google Sheets did not connect");
    expect(d.textContent).toContain("Try Google again");
    await act(async () => root.unmount());
  });

  it("shows picker failure state when selector session fails", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [],
        },
      ],
      requirements: [ordersReq],
    }));

    vi.mocked(selectorSession).mockResolvedValue({
      error: "The Google Picker session could not be created.",
    });

    const { root } = await openDialog();

    // Click "Choose spreadsheet" to trigger selector
    const d = dialog();
    const pickBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Choose spreadsheet"),
    );
    expect(pickBtn).toBeTruthy();
    await act(async () => {
      pickBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(d.textContent).toContain("Your spreadsheets could not open");
    expect(d.textContent).toContain("Retry");
    await act(async () => root.unmount());
  });

  it("shows resource validation failure state", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [],
        },
      ],
      requirements: [ordersReq],
    }));

    vi.mocked(selectorSession).mockResolvedValue({
      accessToken: "mock",
      expiresAt: 9999,
      pickerApiKey: "mock",
      projectNumber: "mock",
    });

    vi.mocked(registerResource).mockResolvedValue({
      error: "Orders 2026 could not be verified. No binding was changed.",
    });

    const { root } = await openDialog();

    const d = dialog();
    const pickBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Choose spreadsheet"),
    );
    expect(pickBtn).toBeTruthy();

    await act(async () => {
      pickBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Now select a sheet from mock picker
    const sheetBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Orders 2026"),
    );
    expect(sheetBtn).toBeTruthy();
    await act(async () => {
      sheetBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(d.textContent).toContain("not accessible");
    expect(d.textContent).toContain("Choose another spreadsheet");
    await act(async () => root.unmount());
  });

  it("preserves old binding during replacement validation failure", async () => {
    vi.mocked(listIntegrations).mockResolvedValue(catalog({
      connections: [
        {
          id: "conn_1",
          provider: "google",
          status: "active" as const,
          account: "owner@example.com",
          updatedAt: 1,
          resources: [{ id: "res_1", capability: "google-sheets", alias: "orders", displayName: "Orders 2026" }],
        },
      ],
      requirements: [ordersReq],
    }));

    vi.mocked(selectorSession).mockResolvedValue({
      accessToken: "mock",
      expiresAt: 9999,
      pickerApiKey: "mock",
      projectNumber: "mock",
    });

    vi.mocked(registerResource).mockResolvedValue({
      error: "Validation failed.",
    });

    const { root } = await openDialog();

    const d = dialog();

    // Click Replace (inline on the ready panel)
    const replaceBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Replace"),
    );
    expect(replaceBtn).toBeTruthy();
    await act(async () => {
      replaceBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Pick a sheet
    const sheetBtn = [...d.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Orders 2026"),
    );
    if (sheetBtn) {
      await act(async () => {
        sheetBtn.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    // Should show error with "Choose another spreadsheet"
    expect(d.textContent).toContain("not accessible");
    await act(async () => root.unmount());
  });
});