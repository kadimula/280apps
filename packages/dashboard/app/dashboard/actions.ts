"use server";

import { revalidatePath } from "next/cache";

import { apiFetch } from "@/lib/api";
import { cookieHeader } from "@/lib/session";

// deleteAppAction is the browser half of `280 delete`. It is a POST anyone can
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
