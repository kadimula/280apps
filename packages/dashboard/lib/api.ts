// The dashboard's single door to the platform backend. Every server-side call
// to the API goes through apiFetch, so there is exactly one place that decides
// where a request goes.

// The backend base URL. Required: a self-hoster points TWO80_API at their own
// backend and there is no host baked into this public code, so a misconfigured
// deploy fails loudly instead of silently talking to someone else's platform.
export function apiBase(): string {
  const base = process.env.TWO80_API;
  if (!base) {
    throw new Error(
      "TWO80_API is not set. Point it at your 280 backend base URL, e.g. https://api.example.com",
    );
  }
  return base;
}

// Where an agent fetches the entry prompt to get started, served by the backend
// as an unauthenticated doc. Derived from the backend so it follows TWO80_API.
export function setupPromptUrl(): string {
  return `${apiBase()}/v1/docs/setup.md`;
}

// apiFetch calls the platform for a path like "/auth/me", forwarding init
// unchanged, so callers parse .ok / .status / .json() / .text() as they would
// any fetch.
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${apiBase()}${path}`, init);
}
