// The typed Google Sheets helper an app calls server-side. It carries no credential:
// it forwards the request's gateway-signed X-280-Identity to the 280 SDK API, which
// verifies it, resolves the app's connection and the named resource alias, and runs
// the bounded operation. The app never sees a Google token or a spreadsheet id.
//
//   import { googleSheets } from "@two80/sdk";
//   const sheets = googleSheets(request);
//   await sheets.append({ resource: "orders", range: "Orders!A:D", values: [[id, email, total, at]] });

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

export interface SheetsReadResult {
  range: string;
  majorDimension: string;
  values: unknown[][];
}

export interface SheetsWriteResult {
  updatedRange: string;
  updatedRows: number;
  updatedCells: number;
}

export interface GoogleSheetsClient {
  read(input: SheetsReadInput): Promise<SheetsReadResult>;
  append(input: SheetsWriteInput): Promise<SheetsWriteResult>;
  update(input: SheetsWriteInput): Promise<SheetsWriteResult>;
}

export interface GoogleSheetsOptions {
  origin?: string;
  fetch?: typeof fetch;
}

// The stable error the SDK API returns, surfaced with its code so an app can branch
// (e.g. reauthorization_required → tell the owner to reconnect).
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

export function googleSheets(request: RequestLike, opts: GoogleSheetsOptions = {}): GoogleSheetsClient {
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const token = readHeader(request, ID_HEADER);

  async function call(operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = sdkApiUrl(`/v1/sdk/integrations/google-sheets/${operation}`, { origin: opts.origin });
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        [ID_HEADER]: token,
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
    return data;
  }

  return {
    async read(input) {
      const r = await call('read', { resource: input.resource, range: input.range });
      return {
        range: typeof r.range === 'string' ? r.range : input.range,
        majorDimension: typeof r.majorDimension === 'string' ? r.majorDimension : 'ROWS',
        values: Array.isArray(r.values) ? (r.values as unknown[][]) : [],
      };
    },
    async append(input) {
      return writeResult(await call('append', { resource: input.resource, range: input.range, values: input.values }));
    },
    async update(input) {
      return writeResult(await call('update', { resource: input.resource, range: input.range, values: input.values }));
    },
  };
}

function writeResult(r: Record<string, unknown>): SheetsWriteResult {
  return {
    updatedRange: typeof r.updatedRange === 'string' ? r.updatedRange : '',
    updatedRows: typeof r.updatedRows === 'number' ? r.updatedRows : 0,
    updatedCells: typeof r.updatedCells === 'number' ? r.updatedCells : 0,
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
