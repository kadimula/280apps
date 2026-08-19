import { integrationClient, IntegrationRequestError, type NotReadyCode } from './integrations-common.js';
import type { RequestLike } from './index.js';

export { IntegrationRequestError };
export type { NotReadyCode };

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

export function googleSheets(request: RequestLike, opts: GoogleSheetsOptions = {}): GoogleSheetsClient {
  const { command } = integrationClient(request, 'google-sheets', opts);
  return {
    read: command<SheetsReadInput, SheetsReadResult>('read', (input, notReady) => ({
      range: input.range,
      majorDimension: 'ROWS',
      values: [],
      notReady,
    })),
    append: command<SheetsWriteInput, SheetsWriteResult>('append', (_input, notReady) => emptyWrite(notReady)),
    update: command<SheetsWriteInput, SheetsWriteResult>('update', (_input, notReady) => emptyWrite(notReady)),
    deleteRows: command<SheetsDeleteRowsInput, SheetsDeleteRowsResult>('deleteRows', (input, notReady) => ({
      sheetId: -1,
      deletedRows: 0,
      startRow: input.startRow,
      notReady,
    })),
  };
}

function emptyWrite(notReady: NotReadyCode): SheetsWriteResult {
  return { updatedRange: '', updatedRows: 0, updatedCells: 0, notReady };
}
