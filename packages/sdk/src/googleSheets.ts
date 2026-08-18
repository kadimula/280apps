import { ID_HEADER } from '@280/contracts/identity';
import { sdkApiUrl, type HeaderSource, type RequestLike } from './index.js';

export interface SheetsReadInput {
  resource: string;
  range: string;
}

export interface SheetsWriteInput {
  resource: string;
  range: string;
  values: unknown[][];
}

// Set on any result the platform reported as not-ready (the integration is not
// connected, the bound resource is gone, or the owner must re-authorize). The
// other fields then hold safe empty values, so an app that ignores this flag
// renders an empty state instead of crashing; branch on it to prompt a connect.
export type NotReadyCode = 'not_connected' | 'resource_not_found' | 'reauthorization_required';

export interface SheetsReadResult {
  range: string;
  majorDimension: string;
  values: unknown[][];
  notReady?: NotReadyCode;
}

export interface SheetsWriteResult {
  updatedRange: string;
  updatedRows: number;
  updatedCells: number;
  notReady?: NotReadyCode;
}

export interface SheetsDeleteRowsInput {
  resource: string;
  // A zero-based sheet index or a sheet title. Defaults to the first sheet.
  sheet?: number | string;
  // One-based row number of the first row to delete (row 1 is the first row).
  startRow: number;
  // Number of rows to delete; must be positive.
  rowCount: number;
}

export interface SheetsDeleteRowsResult {
  sheetId: number;
  deletedRows: number;
  startRow: number;
  notReady?: NotReadyCode;
}

export interface GoogleSheetsClient {
  read(input: SheetsReadInput): Promise<SheetsReadResult>;
  append(input: SheetsWriteInput): Promise<SheetsWriteResult>;
  update(input: SheetsWriteInput): Promise<SheetsWriteResult>;
  deleteRows(input: SheetsDeleteRowsInput): Promise<SheetsDeleteRowsResult>;
}

export interface GoogleSheetsOptions {
  origin?: string;
  fetch?: typeof fetch;
}

export class IntegrationRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'IntegrationRequestError';
  }
}

// The platform's expected not-ready states: a human still needs to connect,
// bind, or re-authorize. These degrade to a safe result instead of throwing;
// every other code (provider/unavailable/invalid/unauthenticated/internal) still
// throws IntegrationRequestError so genuine failures surface.
const NOT_READY_CODES = new Set<NotReadyCode>(['not_connected', 'resource_not_found', 'reauthorization_required']);

function notReadyCode(err: unknown): NotReadyCode | null {
  return err instanceof IntegrationRequestError && NOT_READY_CODES.has(err.code as NotReadyCode)
    ? (err.code as NotReadyCode)
    : null;
}

export function googleSheets(request: RequestLike, opts: GoogleSheetsOptions = {}): GoogleSheetsClient {
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const token = readHeader(request, ID_HEADER);

  async function call<T>(operation: string, body: object): Promise<T> {
    const url = sdkApiUrl(`/v1/sdk/integrations/google-sheets/${operation}`, { origin: opts.origin });
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = (text === '' ? {} : safeJson(text)) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof data.error === 'string' ? data.error : 'request_failed';
      const message = typeof data.message === 'string' ? data.message : `google sheets request failed (${res.status})`;
      throw new IntegrationRequestError(code, message, res.status, data.retryable === true);
    }
    return data as T;
  }

  async function graceful<T>(run: () => Promise<T>, fallback: (code: NotReadyCode) => T): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const code = notReadyCode(err);
      if (code !== null) return fallback(code);
      throw err;
    }
  }

  return {
    read: (input) =>
      graceful(
        () => call<SheetsReadResult>('read', input),
        (notReady) => ({ range: input.range, majorDimension: 'ROWS', values: [], notReady }),
      ),
    append: (input) =>
      graceful(
        () => call<SheetsWriteResult>('append', input),
        (notReady) => ({ updatedRange: '', updatedRows: 0, updatedCells: 0, notReady }),
      ),
    update: (input) =>
      graceful(
        () => call<SheetsWriteResult>('update', input),
        (notReady) => ({ updatedRange: '', updatedRows: 0, updatedCells: 0, notReady }),
      ),
    deleteRows: (input) =>
      graceful(
        () => call<SheetsDeleteRowsResult>('deleteRows', input),
        (notReady) => ({ sheetId: -1, deletedRows: 0, startRow: input.startRow, notReady }),
      ),
  };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readHeader(request: RequestLike, name: string): string {
  const direct = request as HeaderSource;
  const src = typeof direct.get === 'function' ? direct : (request as { headers: HeaderSource }).headers;
  const v = src.get(name) ?? src.get(name.toLowerCase());
  return typeof v === 'string' ? v : '';
}
