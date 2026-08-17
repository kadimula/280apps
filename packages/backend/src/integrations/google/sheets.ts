import type { sheets_v4 } from '@googleapis/sheets';
import { ResourceValidationError } from '../provider.js';
import { translateSheets, type SheetsClient } from './client.js';

export type SheetSelector = number | string;

export async function readValues(api: SheetsClient, spreadsheetId: string, range: string): Promise<Record<string, unknown>> {
  const res = await api.spreadsheets.values.get({ spreadsheetId, range }).catch((err) => translateSheets(err, 'read'));
  const data = res.data;
  return {
    range: strOr(data.range, range),
    majorDimension: strOr(data.majorDimension, 'ROWS'),
    values: Array.isArray(data.values) ? data.values : [],
  };
}

export async function appendValues(
  api: SheetsClient,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): Promise<Record<string, unknown>> {
  const res = await api.spreadsheets.values
    .append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: values as unknown[][] },
    })
    .catch((err) => translateSheets(err, 'append'));
  const updates = res.data.updates ?? {};
  return {
    updatedRange: strOr(updates.updatedRange, ''),
    updatedRows: numOr(updates.updatedRows, 0),
    updatedCells: numOr(updates.updatedCells, 0),
  };
}

export async function updateValues(
  api: SheetsClient,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): Promise<Record<string, unknown>> {
  const res = await api.spreadsheets.values
    .update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { range, values: values as unknown[][] },
    })
    .catch((err) => translateSheets(err, 'update'));
  const data = res.data;
  return {
    updatedRange: strOr(data.updatedRange, ''),
    updatedRows: numOr(data.updatedRows, 0),
    updatedCells: numOr(data.updatedCells, 0),
  };
}

export async function deleteRows(
  api: SheetsClient,
  spreadsheetId: string,
  sheet: SheetSelector,
  startRow: number,
  rowCount: number,
): Promise<Record<string, unknown>> {
  const meta = await api.spreadsheets
    .get({ spreadsheetId, fields: 'sheets.properties(sheetId,index,title)' })
    .catch((err) => translateSheets(err, 'deleteRows'));
  const sheetId = resolveSheetId(meta.data.sheets ?? [], sheet);
  const startIndex = startRow - 1;
  const endIndex = startIndex + rowCount;
  await api.spreadsheets
    .batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex, endIndex } } }] },
    })
    .catch((err) => translateSheets(err, 'deleteRows'));
  return { sheetId, deletedRows: rowCount, startRow };
}

function resolveSheetId(sheets: sheets_v4.Schema$Sheet[], selector: SheetSelector): number {
  for (const s of sheets) {
    const props = s.properties;
    if (props === undefined || props === null || typeof props.sheetId !== 'number') continue;
    if (typeof selector === 'number' ? props.index === selector : props.title === selector) return props.sheetId;
  }
  const label = typeof selector === 'number' ? `index ${selector}` : `"${selector}"`;
  throw new ResourceValidationError(`deleteRows: no sheet matches ${label}`);
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}
