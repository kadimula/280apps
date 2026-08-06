"use server";

import { apiFetch } from "@/lib/api";
import { cookieHeader } from "@/lib/session";

export type AppVariable = {
  name: string;
  configured: boolean;
  setBy?: string;
  setAt?: number;
};

async function failureMessage(res: Response): Promise<string> {
  if (res.status === 401) return "Sign in again.";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const message = body.error ?? body.message;
    if (typeof message === "string" && message) return message;
  } catch {}
  return "Something went wrong. Try again shortly.";
}

export async function listVariables(
  appId: string,
): Promise<{ variables: AppVariable[] } | { error: string }> {
  let res: Response;
  try {
    res = await apiFetch(`/internal/apps/${encodeURIComponent(appId)}/secrets`, {
      headers: { Cookie: await cookieHeader() },
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  const body = (await res.json()) as { secrets?: AppVariable[] };
  return { variables: body.secrets ?? [] };
}

export async function revealVariable(
  appId: string,
  name: string,
): Promise<{ value: string } | { error: string }> {
  let res: Response;
  try {
    res = await apiFetch(
      `/internal/apps/${encodeURIComponent(appId)}/secrets/reveal`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await cookieHeader(),
        },
        body: JSON.stringify({ name }),
        cache: "no-store",
      },
    );
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
  const body = (await res.json()) as { value?: unknown };
  return typeof body.value === "string"
    ? { value: body.value }
    : { error: "The variable could not be revealed." };
}

export async function deleteVariable(
  appId: string,
  name: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(
      `/internal/apps/${encodeURIComponent(appId)}/secrets/delete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await cookieHeader(),
        },
        body: JSON.stringify({ name }),
        cache: "no-store",
      },
    );
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
}

export async function setVariable(
  appId: string,
  name: string,
  value: string,
): Promise<{ error: string } | void> {
  let res: Response;
  try {
    res = await apiFetch(`/internal/apps/${encodeURIComponent(appId)}/secrets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await cookieHeader(),
      },
      body: JSON.stringify({ name, value }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the platform." };
  }
  if (!res.ok) return { error: await failureMessage(res) };
}
