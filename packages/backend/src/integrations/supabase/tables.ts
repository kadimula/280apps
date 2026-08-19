import { ProviderRequestError, ResourceValidationError } from '../provider.js';
import type { FetchImpl } from './client.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface RestTarget {
  ref: string;
  schema: string;
  table: string;
}

export interface Filter {
  column: string;
  op: string;
  value: unknown;
}

type RestResult = { rows: unknown[]; count: number };

// A non-ok PostgREST response, surfaced raw so the provider can evict-and-retry on an
// expired key (401/403) before translating the terminal error.
export class RestStatusError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`the data API returned HTTP ${status}`);
    this.name = 'RestStatusError';
  }
}

export function translateRest(err: RestStatusError): never {
  const { status, detail } = err;
  if (status === 404) throw new ResourceValidationError('the table is unavailable');
  if (status === 429 || status >= 500) throw new ProviderRequestError('the data API is temporarily unavailable', true);
  const suffix = detail !== '' ? `: ${detail}` : '';
  throw new ProviderRequestError(`the data API rejected the request${suffix}`, false);
}

export async function selectRows(
  fetchImpl: FetchImpl,
  key: string,
  target: RestTarget,
  opts: { columns?: string[]; filters: Filter[]; limit: number },
): Promise<RestResult> {
  const params = new URLSearchParams();
  params.set('select', opts.columns !== undefined && opts.columns.length > 0 ? opts.columns.join(',') : '*');
  applyFilters(params, opts.filters);
  params.set('limit', String(opts.limit));
  const res = await send(fetchImpl, `${restUrl(target)}?${params.toString()}`, {
    method: 'GET',
    headers: headers(key, 'count=exact'),
  });
  const rows = await parseRows(res);
  return { rows, count: parseCount(res.headers.get('Content-Range'), rows.length) };
}

export async function insertRows(
  fetchImpl: FetchImpl,
  key: string,
  target: RestTarget,
  rows: unknown[],
): Promise<{ rows: unknown[]; insertedCount: number }> {
  const res = await send(fetchImpl, restUrl(target), {
    method: 'POST',
    headers: headers(key, 'return=representation'),
    body: JSON.stringify(rows),
  });
  const out = await parseRows(res);
  return { rows: out, insertedCount: out.length };
}

export async function updateRows(
  fetchImpl: FetchImpl,
  key: string,
  target: RestTarget,
  values: Record<string, unknown>,
  filters: Filter[],
): Promise<{ rows: unknown[]; updatedCount: number }> {
  const params = new URLSearchParams();
  applyFilters(params, filters);
  const res = await send(fetchImpl, `${restUrl(target)}?${params.toString()}`, {
    method: 'PATCH',
    headers: headers(key, 'return=representation'),
    body: JSON.stringify(values),
  });
  const out = await parseRows(res);
  return { rows: out, updatedCount: out.length };
}

export async function deleteRows(
  fetchImpl: FetchImpl,
  key: string,
  target: RestTarget,
  filters: Filter[],
): Promise<{ deletedCount: number }> {
  const params = new URLSearchParams();
  applyFilters(params, filters);
  const res = await send(fetchImpl, `${restUrl(target)}?${params.toString()}`, {
    method: 'DELETE',
    headers: headers(key, 'return=representation'),
  });
  const out = await parseRows(res);
  return { deletedCount: out.length };
}

function restUrl(target: RestTarget): string {
  return `https://${target.ref}.supabase.co/rest/v1/${encodeURIComponent(target.table)}`;
}

function headers(key: string, prefer: string): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  };
}

function applyFilters(params: URLSearchParams, filters: Filter[]): void {
  for (const f of filters) {
    if (f.op === 'is') params.append(f.column, `is.${isValue(f.value)}`);
    else if (f.op === 'in') params.append(f.column, `in.(${inList(f.value)})`);
    else params.append(f.column, `${f.op}.${String(f.value)}`);
  }
}

function isValue(v: unknown): string {
  if (v === null) return 'null';
  return v === true ? 'true' : 'false';
}

function inList(v: unknown): string {
  const items = Array.isArray(v) ? v : [];
  return items
    .map((e) => (typeof e === 'string' ? `"${e.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : String(e)))
    .join(',');
}

function parseCount(contentRange: string | null, fallback: number): number {
  if (contentRange === null) return fallback;
  const total = contentRange.split('/')[1];
  const n = total === undefined ? NaN : Number(total);
  return Number.isFinite(n) ? n : fallback;
}

async function parseRows(res: Response): Promise<unknown[]> {
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function send(
  fetchImpl: FetchImpl,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ProviderRequestError('the data API is unreachable', true);
  }
  if (!res.ok) throw new RestStatusError(res.status, await messageOf(res));
  return res;
}

async function messageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}
