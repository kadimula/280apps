"use server";

import { revalidatePath } from "next/cache";

import { apiFetch } from "@/lib/api";
import { cookieHeader } from "@/lib/session";

// The Share dialog's calls to the platform's grant and access endpoints. Like
// deleteAppAction, each is a POST/GET anyone could forge, so it carries the
// browser's session and the backend decides everything that matters: ownership
// of the app, who the caller is, validity of the principal, the last-owner
// guard, and whether the caller may open an app to the public. This file only
// moves the request and translates failures into a sentence the dialog can show
// inline.

// One row of GET /internal/apps/:id/grants, exactly as the backend returns it.
// The dialog reads principal and appRole; the rest rides along so any future
// consumer of the same list (a "view as" picker) sees the full shape.
export type Grant = {
  principal: string;
  appRole: string;
  featureRole: string;
  grantedBy: string;
  grantedAt: number;
};

// The backend explains its refusals (bad email, last-owner guard) in the
// response body; those messages are written for people, so surface them. A
// lapsed session and an unreadable body get our own words.
async function failureMessage(res: Response): Promise<string> {
  if (res.status === 401) return "Sign in again.";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const message = body.error ?? body.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Fall through to the generic line.
  }
  return "Something went wrong. Try again shortly.";
}

// The three ways an app decides who may open it at all, mirroring APP_ACCESS in
// the platform's contracts. Anything else the backend might send is coerced to
// invited, the same fail-closed default it uses.
export type AppAccess = "invited" | "anyone-at-tenant" | "public";

function asAccess(v: unknown): AppAccess {
  return v === "anyone-at-tenant" || v === "public" ? v : "invited";
}

// Everything the grants list tells the dialog beyond the rows themselves: the
// effective access mode, whether it came from 280.json or a previous dashboard
// change, and the owner's tenant, which names the "Anyone at ..." option and,
// when it is a consumer mail domain, disqualifies it.
export type AccessInfo = {
  access: AppAccess;
  accessSource: "manifest" | "dashboard";
  ownerTenant: string;
  ownerTenantIsConsumer: boolean;
};

export async function listViewGrants(
  appId: string,
): Promise<({ grants: Grant[] } & AccessInfo) | { error: string }> {
  let res: Response;
  try {
    res = await apiFetch(`/internal/apps/${encodeURIComponent(appId)}/grants`, {
      headers: { Cookie: await cookieHeader() },
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  const body = (await res.json()) as {
    grants?: Grant[];
    access?: unknown;
    accessSource?: unknown;
    ownerTenant?: unknown;
    ownerTenantIsConsumer?: unknown;
  };
  return {
    grants: body.grants ?? [],
    access: asAccess(body.access),
    accessSource: body.accessSource === "dashboard" ? "dashboard" : "manifest",
    ownerTenant: typeof body.ownerTenant === "string" ? body.ownerTenant : "",
    ownerTenantIsConsumer: body.ownerTenantIsConsumer === true,
  };
}

// setAppAccess writes the dashboard override behind the dialog's General access
// dial. The backend is owner-only here and the override wins over 280.json on
// every future deploy, so a change made in the dialog is durable.
export async function setAppAccess(
  appId: string,
  access: AppAccess,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(`/internal/apps/${encodeURIComponent(appId)}/access`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await cookieHeader(),
      },
      body: JSON.stringify({ access }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  revalidatePath("/dashboard/[id]", "page");
}

export async function grantView(
  appId: string,
  email: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(`/internal/apps/${encodeURIComponent(appId)}/grants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await cookieHeader(),
      },
      body: JSON.stringify({ principal: email, appRole: "viewer" }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  // The app page's "View as" menu lists these same people; re-render it so a
  // freshly added viewer is immediately offerable as a preview target.
  revalidatePath("/dashboard/[id]", "page");
}

export async function revokeView(
  appId: string,
  principal: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(
      `/internal/apps/${encodeURIComponent(appId)}/grants/revoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await cookieHeader(),
        },
        body: JSON.stringify({ principal }),
        cache: "no-store",
      },
    );
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  revalidatePath("/dashboard/[id]", "page");
}
