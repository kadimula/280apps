"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { apiFetch } from "@/lib/api";
import { MOCK_AUTH_COOKIE } from "@/lib/mock-backend";
import { cookieHeader } from "@/lib/session";

// Dev-only, mock-mode only. The floating mock-auth toggle writes this cookie to
// flip the mock between signed in and signed out, so the landing and sign-in
// pages can be iterated without editing MOCK_USER or restarting. Only the mock
// reads it (see lib/mock-backend), so against a real backend it does nothing.
// Signed in is the absence of the cookie; setting it to "out" forces signed out.
export async function setMockAuthAction(signedIn: boolean) {
  const jar = await cookies();
  if (signedIn) jar.delete(MOCK_AUTH_COOKIE);
  else jar.set(MOCK_AUTH_COOKIE, "out", { path: "/", sameSite: "lax" });
}

// deleteAppAction is the browser half of `two80 delete`. It is a POST anyone can
// forge, so it carries the browser's session and takes only a reference (the app
// id) and the typed confirmation. Ownership, identity, and the confirmation are
// the backend's, the same code path the CLI goes through.
export async function deleteAppAction(
  appId: string,
  confirm: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(`/internal/apps/${encodeURIComponent(appId)}/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await cookieHeader(),
      },
      body: JSON.stringify({ confirm }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }

  if (!res.ok) {
    // 428 is a bad confirmation, the only failure the dialog can fix itself. 401
    // is a session that lapsed. Everything else is ours to explain.
    if (res.status === 428) return { error: 'Type "delete" to confirm.' };
    if (res.status === 401) return { error: "Sign in again." };
    return { error: "Could not delete. Try again shortly." };
  }

  revalidatePath("/dashboard");
}
