import { describe, expect, it } from "vitest";

import { mockResponse } from "@/lib/mock-backend";
import { MOCK_SHEETS } from "@/lib/mock-sheets";

// The mock backend stands in for the real integrations routes. These pin the
// contract the Integrations dialog drives so the offline flow stays faithful:
// a fresh app has no connection, connect stands one up, a picked sheet aliases
// under it, and disconnect removes it.

const APP = "app-fixture";
const base = `/internal/apps/${APP}/integrations`;

function post(path: string, body?: unknown) {
  return mockResponse(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Catalog = {
  providers: { provider: string; capabilities: string[] }[];
  connections: {
    id: string;
    provider: string;
    status: string;
    resources: { id: string; capability: string; alias: string; displayName: string }[];
  }[];
  requirements: { alias: string; capability: string; operations: string[] }[];
};

async function list(appId = APP): Promise<Catalog> {
  const res = mockResponse(`/internal/apps/${appId}/integrations`);
  return (await res.json()) as Catalog;
}

// Mirrors the dialog's readiness check: a required alias is ready only when a
// resource with the same capability and alias is bound under some connection.
function requirementReady(
  cat: Catalog,
  req: { alias: string; capability: string },
): boolean {
  return cat.connections.some((c) =>
    c.resources.some((r) => r.capability === req.capability && r.alias === req.alias),
  );
}

describe("mock integrations backend", () => {
  it("offers the catalog with no connection until connect", async () => {
    const before = await list();
    expect(before.providers).toEqual([
      { provider: "google", capabilities: ["google-sheets"] },
    ]);
    expect(before.connections).toHaveLength(0);
  });

  it("drives connect → pick → alias → disconnect end to end", async () => {
    expect((await post(`${base}/google/connect`)).status).toBe(204);

    const connected = await list();
    expect(connected.connections).toHaveLength(1);
    const conn = connected.connections[0]!;
    expect(conn.status).toBe("active");

    const sel = await post(`${base}/${conn.id}/selector-session`);
    expect(sel.status).toBe(200);

    const sheet = MOCK_SHEETS[0]!;
    const reg = await post(`${base}/${conn.id}/resources`, {
      capability: "google-sheets",
      alias: "orders",
      externalId: sheet.id,
    });
    expect(reg.status).toBe(200);
    expect(((await reg.json()) as { displayName: string }).displayName).toBe(
      sheet.name,
    );

    const withResource = await list();
    expect(withResource.connections[0]!.resources).toHaveLength(1);
    const resource = withResource.connections[0]!.resources[0]!;
    expect(resource.alias).toBe("orders");

    // A duplicate alias is rejected, and a bad alias is rejected.
    expect(
      (await post(`${base}/${conn.id}/resources`, {
        capability: "google-sheets",
        alias: "orders",
        externalId: sheet.id,
      })).status,
    ).toBe(422);
    expect(
      (await post(`${base}/${conn.id}/resources`, {
        capability: "google-sheets",
        alias: "bad alias",
        externalId: sheet.id,
      })).status,
    ).toBe(422);

    expect(
      (await post(`${base}/resources/delete`, { resourceId: resource.id }))
        .status,
    ).toBe(204);
    expect((await list()).connections[0]!.resources).toHaveLength(0);

    const disc = mockResponse(`${base}/${conn.id}`, { method: "DELETE" });
    expect(disc.status).toBe(204);
    expect((await list()).connections).toHaveLength(0);
  });

  // The parked-handoff case: an app declares a required alias, and binding a
  // spreadsheet to that exact alias readies it — the same state the backend's
  // resumeWaiting gate keys on to un-park and roll out the deploy.
  it("readies a declared required alias when it is bound", async () => {
    const REQ_APP = "app-notes";
    const reqBase = `/internal/apps/${REQ_APP}/integrations`;

    const before = await list(REQ_APP);
    const required = before.requirements.find((r) => r.alias === "orders");
    expect(required).toMatchObject({ capability: "google-sheets", operations: ["read", "append"] });
    expect(requirementReady(before, required!)).toBe(false);

    expect((await post(`${reqBase}/google/connect`)).status).toBe(204);
    const conn = (await list(REQ_APP)).connections[0]!;

    // Binding a different alias does NOT ready the requirement.
    await post(`${reqBase}/${conn.id}/resources`, {
      capability: "google-sheets",
      alias: "inventory",
      externalId: MOCK_SHEETS[1]!.id,
    });
    expect(requirementReady(await list(REQ_APP), required!)).toBe(false);

    // Binding the declared alias readies it.
    const reg = await post(`${reqBase}/${conn.id}/resources`, {
      capability: "google-sheets",
      alias: "orders",
      externalId: MOCK_SHEETS[0]!.id,
    });
    expect(reg.status).toBe(200);
    expect(requirementReady(await list(REQ_APP), required!)).toBe(true);
  });
});
