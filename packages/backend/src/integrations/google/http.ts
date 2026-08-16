// Bounded HTTP for the Google adapter: a hard timeout and a response-size cap, so a
// slow or oversized upstream cannot hang a request or exhaust memory. Errors are
// normalized to ProviderRequestError; no upstream response body reaches a caller.

import { ProviderRequestError } from '../provider.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1 << 20;

export interface HttpResult {
  status: number;
  text: string;
}

export async function httpRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ProviderRequestError(aborted ? 'provider request timed out' : 'provider request failed', true);
  } finally {
    clearTimeout(timer);
  }
  const text = await readCapped(res, opts.maxBytes ?? MAX_RESPONSE_BYTES);
  return { status: res.status, text };
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        seen += value.byteLength;
        if (seen > max) throw new ProviderRequestError('provider response exceeded the size limit', false);
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
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
