import { apiFetch } from "@/lib/api";

// Docs are owned by the platform (control plane), which serves them at stable
// URLs as both markdown and JSON. This module is the dashboard's thin client:
// the /docs page fetches through apiFetch so every doc surface hits the same
// backend the dashboard already talks to. Docs are unauthenticated, so no cookie
// is sent.

// The matrix moves only when a capability does, so a 5 minute revalidate keeps
// a busy agent fleet off the origin without letting the docs drift for long.
const REVALIDATE_SECS = 300;

export interface CapabilityFeature {
  name: string;
  status: "supported" | "unsupported";
  note?: string;
}

export interface CapabilityGroup {
  name: string;
  features: CapabilityFeature[];
}

export interface DocsCapabilities {
  matrix: CapabilityGroup[];
  requirement: string;
}

// fetchDocMarkdown returns the raw markdown for a doc path (e.g. "setup.md"), or
// throws if the platform could not serve it. Callers turn the throw into a 502
// so a proxied doc never silently serves an empty or half body.
export async function fetchDocMarkdown(path: string): Promise<string> {
  const res = await apiFetch(`/v1/docs/${path}`, {
    next: { revalidate: REVALIDATE_SECS },
  });
  if (!res.ok) {
    throw new Error(`platform returned ${res.status} for ${path}`);
  }
  return res.text();
}

// fetchCapabilities returns the structured support matrix the /docs page renders.
export async function fetchCapabilities(): Promise<DocsCapabilities> {
  const res = await apiFetch(`/v1/docs/capabilities`, {
    next: { revalidate: REVALIDATE_SECS },
  });
  if (!res.ok) {
    throw new Error(`platform returned ${res.status} for capabilities`);
  }
  return res.json() as Promise<DocsCapabilities>;
}
