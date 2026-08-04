import { apiFetch } from "@/lib/api";
import { cookieHeader } from "@/lib/session";

// The dashboard's app preview never points the iframe straight at the app URL:
// the app lives on a different registrable domain, so the owner's dashboard
// session means nothing there and the frame would show the app's own sign-in.
// Instead the page asks the platform for a short-lived preview grant, and the
// iframe loads the returned bootstrap URL (/__280/preview?g=...), where the
// gateway mints an in-frame identity from the grant. "View as" is the same
// mint with a target identity baked into the grant.

// Who the preview renders the app as: the owner themselves (none), the owner
// at a lower role, or a specific person. Mirrors the platform's ViewAsTarget.
export type ViewAsTarget =
  | { kind: "none" }
  | { kind: "role"; appRole: string; featureRole: string }
  | { kind: "user"; email: string };

// The roles below owner, the ones worth previewing as. Owner is the default
// view, so it is not an entry.
export const VIEW_AS_ROLES = ["admin", "editor", "viewer"] as const;

// The dropdown's selection rides in the page URL as ?as=user:<email> or
// ?as=role:<role>, so a reload or a shared link lands on the same view and the
// server can mint the matching grant during render. Anything unrecognized is
// the owner's own view: a stale or hand-edited param must never widen anything,
// and the backend re-validates the target regardless.
export function parseViewAs(raw: string | undefined): ViewAsTarget {
  if (raw?.startsWith("user:")) {
    const email = raw.slice("user:".length).trim().toLowerCase();
    if (email.includes("@")) return { kind: "user", email };
  }
  if (raw?.startsWith("role:")) {
    const appRole = raw.slice("role:".length).trim();
    if ((VIEW_AS_ROLES as readonly string[]).includes(appRole)) {
      return { kind: "role", appRole, featureRole: "" };
    }
  }
  return { kind: "none" };
}

// mintPreviewUrl asks the platform for a preview grant and returns the bootstrap
// URL the iframe should load, or null when no preview could be established (no
// session, not the owner, platform unreachable). The page renders null as the
// open-in-a-new-tab fallback, so like getMe this never throws.
export async function mintPreviewUrl(
  appId: string,
  viewAs: ViewAsTarget,
): Promise<string | null> {
  try {
    const res = await apiFetch(
      `/internal/apps/${encodeURIComponent(appId)}/preview-grant`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await cookieHeader(),
        },
        body: JSON.stringify({ viewAs }),
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { url?: unknown };
    return typeof body.url === "string" && body.url !== "" ? body.url : null;
  } catch {
    return null;
  }
}
