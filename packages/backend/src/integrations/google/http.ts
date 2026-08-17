import { ProviderRequestError } from '../provider.js';

const TIMEOUT_MS = 10_000;

export interface HttpResult {
  status: number;
  text: string;
}

export async function httpRequest(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    throw new ProviderRequestError(timedOut ? 'provider request timed out' : 'provider request failed', true);
  } finally {
    clearTimeout(timer);
  }
}

export function parseJson(text: string): Record<string, unknown> {
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ProviderRequestError('provider returned a malformed response', false);
  }
}
