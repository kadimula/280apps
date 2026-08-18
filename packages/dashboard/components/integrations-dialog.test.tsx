// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationsDialog } from "@/components/integrations-dialog";
import { listIntegrations } from "@/lib/integrations";

vi.mock("@/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations")>()),
  listIntegrations: vi.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const app = { id: "app_1af8df68e0f6", slug: "sheets-todo" };
const provider = { provider: "google", capabilities: ["google-sheets"] };

async function openDialog() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<IntegrationsDialog app={app} apiBase="" mock />));
  await act(async () => {
    (host.querySelector("button") as HTMLButtonElement).click();
    await Promise.resolve();
  });
  return { host, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.mocked(listIntegrations).mockReset();
});

describe("IntegrationsDialog", () => {
  it("renders with the deep link auto open flag during SSR", () => {
    const html = renderToStaticMarkup(
      <IntegrationsDialog app={app} apiBase="" mock autoOpen />,
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("Integrations");
  });

  it("offers exactly one connect action for a manifest requirement", async () => {
    vi.mocked(listIntegrations).mockResolvedValue({
      providers: [provider],
      connections: [],
      requirements: [{ alias: "orders", capability: "google-sheets", operations: ["read", "append"] }],
    });

    const { root } = await openDialog();
    const dialog = document.querySelector('[role="dialog"]')!;
    const connectActions = [...dialog.querySelectorAll("button")].filter((button) => button.textContent === "Connect");

    expect(dialog.textContent).toContain("orders");
    expect(connectActions).toHaveLength(1);
    expect(dialog.textContent).not.toContain("Add spreadsheet");
    await act(async () => root.unmount());
  });

  it("shows an empty state without manual provisioning when the manifest has no requirements", async () => {
    vi.mocked(listIntegrations).mockResolvedValue({
      providers: [provider],
      connections: [],
      requirements: [],
    });

    const { root } = await openDialog();
    const dialog = document.querySelector('[role="dialog"]')!;

    expect(dialog.textContent).toContain("No integrations requested");
    expect(dialog.textContent).not.toContain("Connect");
    expect(dialog.textContent).not.toContain("Add spreadsheet");
    await act(async () => root.unmount());
  });
});
