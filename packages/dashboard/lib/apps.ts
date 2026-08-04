import { apiFetch } from "@/lib/api";
import { cookieHeader } from "@/lib/session";

// Where the dashboard and every per-app page get their apps. Both the list and a
// single app's page resolve the same way — same backend, same session — so that
// logic lives here once rather than in each page.

export type App = {
  id: string;
  slug: string;
  url: string;
  live: boolean;
};

// getApps returns null when the backend could not be reached, which pages render
// as an error rather than as "you have no apps": those are opposite messages to
// someone who just deployed one. An empty array means no apps. The browser's
// session names the owner; there is no subject to pass.
export async function getApps(): Promise<App[] | null> {
  try {
    const res = await apiFetch("/internal/apps", {
      headers: { Cookie: await cookieHeader() },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { apps?: App[] };
    return body.apps ?? [];
  } catch {
    return null;
  }
}

// getApp returns a single app by id, or null when it does not exist (or the
// backend was unreachable). The two are indistinguishable to a caller that just
// wants "the app or nothing", which is all a per-app page needs.
export async function getApp(id: string): Promise<App | null> {
  const apps = await getApps();
  return apps?.find((app) => app.id === id) ?? null;
}
