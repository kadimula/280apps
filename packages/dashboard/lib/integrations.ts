"use server";

import { apiFetch } from "@/lib/api";
import { cookieHeader } from "@/lib/session";

// The owner-facing integrations surface: list a provider catalog and the app's
// connections, open a Google Picker session, alias a picked spreadsheet, and
// remove resources or disconnect. Every call forwards the browser's session so
// the backend scopes it to the app the owner is managing, exactly like the other
// per-app dialogs. The connect step itself is a top-level redirect the dialog
// builds against the backend, not a call here (the OAuth cookie must reach the
// browser); mockConnect stands in for that round-trip when the mock backend is on.

export type IntegrationProvider = { provider: string; capabilities: string[] };

// A required integration the app declared in 280.json: a stable alias, the
// capability it fulfills, and the operations the app calls. It never carries a
// resource id — the owner binds the alias to a picked resource in this dialog.
export type IntegrationRequirement = {
  alias: string;
  capability: string;
  operations: string[];
};

export type IntegrationResource = {
  id: string;
  capability: string;
  alias: string;
  displayName: string;
};

export type IntegrationStatus = "active" | "reauthorization_required";

export type IntegrationConnection = {
  id: string;
  provider: string;
  status: IntegrationStatus;
  account: string;
  updatedAt: number;
  resources: IntegrationResource[];
};

export type IntegrationCatalog = {
  providers: IntegrationProvider[];
  connections: IntegrationConnection[];
  requirements: IntegrationRequirement[];
};

export type SelectorSession = {
  accessToken: string;
  expiresAt: number;
  pickerApiKey: string;
  projectNumber: string;
};

async function failureMessage(res: Response): Promise<string> {
  if (res.status === 401) return "Sign in again.";
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;
  const message = body?.error ?? body?.message;
  return typeof message === "string" && message
    ? message
    : "Something went wrong. Try again shortly.";
}

function base(appId: string): string {
  return `/internal/apps/${encodeURIComponent(appId)}/integrations`;
}

export async function listIntegrations(
  appId: string,
): Promise<IntegrationCatalog | { error: string }> {
  let res: Response;
  try {
    res = await apiFetch(base(appId), {
      headers: { Cookie: await cookieHeader() },
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  const body = (await res.json()) as Partial<IntegrationCatalog>;
  return {
    providers: body.providers ?? [],
    connections: body.connections ?? [],
    requirements: body.requirements ?? [],
  };
}

// The mock stand-in for a completed OAuth consent. In a live environment the
// dialog navigates the browser to the backend's /start route instead, so this is
// never called; it only lets the mock backend land a connection with no Google.
export async function mockConnect(
  appId: string,
  provider: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(`${base(appId)}/${encodeURIComponent(provider)}/connect`, {
      method: "POST",
      headers: { Cookie: await cookieHeader() },
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
}

export async function selectorSession(
  appId: string,
  connectionId: string,
): Promise<SelectorSession | { error: string }> {
  let res: Response;
  try {
    res = await apiFetch(
      `${base(appId)}/${encodeURIComponent(connectionId)}/selector-session`,
      {
        method: "POST",
        headers: { Cookie: await cookieHeader() },
        cache: "no-store",
      },
    );
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  return (await res.json()) as SelectorSession;
}

export async function registerResource(
  appId: string,
  connectionId: string,
  capability: string,
  alias: string,
  externalId: string,
): Promise<{ displayName: string } | { error: string }> {
  let res: Response;
  try {
    res = await apiFetch(
      `${base(appId)}/${encodeURIComponent(connectionId)}/resources`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await cookieHeader(),
        },
        body: JSON.stringify({ capability, alias, externalId }),
        cache: "no-store",
      },
    );
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  const body = (await res.json()) as { displayName?: unknown };
  return {
    displayName: typeof body.displayName === "string" ? body.displayName : alias,
  };
}

export async function removeResource(
  appId: string,
  resourceId: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(`${base(appId)}/resources/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await cookieHeader(),
      },
      body: JSON.stringify({ resourceId }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
}

export async function disconnect(
  appId: string,
  connectionId: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(`${base(appId)}/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
      headers: { Cookie: await cookieHeader() },
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
}
