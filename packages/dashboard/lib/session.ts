import { cookies } from "next/headers";

import { apiBase, apiFetch } from "@/lib/api";

// The dashboard's whole relationship with identity: it asks the backend who the
// browser is and forwards the browser's cookies when it calls the backend on the
// browser's behalf. There is no database here and no auth logic beyond that.

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image: string;
};

// cookieHeader is the browser's cookies as a header, so a server-side call to
// the backend carries the session and the backend authenticates it exactly as
// if the browser had called directly.
export async function cookieHeader(): Promise<string> {
  return (await cookies()).toString();
}

// getMe returns the signed-in user, or null when the browser has no valid
// session. Never throws: a signed-out browser is a null user, not an error.
export async function getMe(): Promise<SessionUser | null> {
  try {
    const res = await apiFetch("/auth/me", {
      headers: { Cookie: await cookieHeader() },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user: SessionUser | null };
    return body.user ?? null;
  } catch {
    return null;
  }
}

export type LoginProvider = "google" | "microsoft";

// loginHref is where the browser goes to sign in: the backend's login flow for the
// chosen provider, told where to send the browser back to afterward.
export function loginHref(redirect = "/dashboard", provider: LoginProvider = "google"): string {
  return `${apiBase()}/auth/${provider}/start?redirect=${encodeURIComponent(redirect)}`;
}

// logoutHref clears the session. It is posted to as a top-level navigation so the
// cleared cookie reaches the browser.
export function logoutHref(): string {
  return `${apiBase()}/auth/logout`;
}
