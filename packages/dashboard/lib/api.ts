import { mockResponse } from "@/lib/mock-backend";

// The dashboard's single door to the platform backend. Every server-side call
// to the API goes through apiFetch, so there is exactly one place that decides
// where a request goes and one place the mock backend can stand in.

// MOCK_BACKEND swaps every API call for a canned response so the dashboard can
// be built and iterated with no backend reachable at all. It is gated on
// NODE_ENV so a stray env var can never make a production deploy serve fake
// data. Set TWO80_MOCK_BACKEND=true in .env.local.
export const MOCK_BACKEND =
  process.env.TWO80_MOCK_BACKEND === "true" &&
  process.env.NODE_ENV !== "production";

// The backend base URL. Required: a self-hoster points TWO80_API at their own
// backend and there is no host baked into this public code, so a misconfigured
// deploy fails loudly instead of silently talking to someone else's platform.
// In mock mode there is no backend to name, so a placeholder stands in for the
// login/logout links (the mock never actually reaches it).
export function apiBase(): string {
  const base = process.env.TWO80_API;
  if (base) return base;
  if (MOCK_BACKEND) return "https://mock.280apps.local";
  throw new Error(
    "TWO80_API is not set. Point it at your 280 backend base URL, e.g. https://api.example.com",
  );
}

// apiFetch calls the platform for a path like "/auth/me", forwarding init
// unchanged. In mock mode it returns a real Response built by the mock router
// instead, so callers parse .ok / .status / .json() / .text() exactly as they
// would a live one and need no mock-specific branch of their own.
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (MOCK_BACKEND) return mockResponse(path, init);
  return fetch(`${apiBase()}${path}`, init);
}
