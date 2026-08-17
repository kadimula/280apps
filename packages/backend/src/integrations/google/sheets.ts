import { ProviderRequestError, ResourceValidationError } from '../provider.js';
import { httpRequest, parseJson } from './http.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

function valuesUrl(spreadsheetId: string, range: string, suffix = ''): string {
  return `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

function raiseFor(status: number, context: string): never {
  if (status === 401 || status === 403) throw new ResourceValidationError(`${context}: access was refused`);
  if (status === 404) throw new ResourceValidationError(`${context}: the spreadsheet is unavailable`);
  if (status === 429 || status >= 500) throw new ProviderRequestError(`${context}: provider unavailable`, true);
  throw new ProviderRequestError(`${context}: request rejected`, false);
}

export async function readValues(
  fetchImpl: typeof fetch,
  token: string,
  spreadsheetId: string,
  range: string,
): Promise<Record<string, unknown>> {
  const res = await httpRequest(fetchImpl, valuesUrl(spreadsheetId, range), {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (res.status < 200 || res.status >= 300) raiseFor(res.status, 'read');
  const body = parseJson(res.text);
  return {
    range: typeof body.range === 'string' ? body.range : range,
    majorDimension: typeof body.majorDimension === 'string' ? body.majorDimension : 'ROWS',
    values: Array.isArray(body.values) ? body.values : [],
  };
}

export async function appendValues(
  fetchImpl: typeof fetch,
  token: string,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): Promise<Record<string, unknown>> {
  const url = valuesUrl(spreadsheetId, range, ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS');
  const res = await httpRequest(fetchImpl, url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (res.status < 200 || res.status >= 300) raiseFor(res.status, 'append');
  const body = parseJson(res.text);
  const updates = (body.updates ?? {}) as Record<string, unknown>;
  return {
    updatedRange: strOr(updates.updatedRange, ''),
    updatedRows: numOr(updates.updatedRows, 0),
    updatedCells: numOr(updates.updatedCells, 0),
  };
}

export async function updateValues(
  fetchImpl: typeof fetch,
  token: string,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): Promise<Record<string, unknown>> {
  const url = valuesUrl(spreadsheetId, range, '?valueInputOption=USER_ENTERED');
  const res = await httpRequest(fetchImpl, url, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, values }),
  });
  if (res.status < 200 || res.status >= 300) raiseFor(res.status, 'update');
  const body = parseJson(res.text);
  return {
    updatedRange: strOr(body.updatedRange, ''),
    updatedRows: numOr(body.updatedRows, 0),
    updatedCells: numOr(body.updatedCells, 0),
  };
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}
