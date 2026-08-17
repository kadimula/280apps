import { OAuth2Client, gaxios } from 'google-auth-library';
import { sheets as sheetsApi, type sheets_v4 } from '@googleapis/sheets';
import { ProviderRequestError, ReauthorizationRequiredError, ResourceValidationError } from '../provider.js';

const REQUEST_TIMEOUT_MS = 10_000;

export type FetchImpl = typeof fetch;
export type SheetsClient = sheets_v4.Sheets;

// The vendor transport is pinned to an injectable fetch so requests stay hermetic in
// tests and the outbound boundary stays a single seam. Every Google call in this folder
// routes through it: OAuth token endpoints, Drive validation, and the Sheets API.
export function makeTransporter(fetchImpl: FetchImpl): gaxios.Gaxios {
  return new gaxios.Gaxios({ fetchImplementation: fetchImpl, timeout: REQUEST_TIMEOUT_MS });
}

export function sheetsFor(transporter: gaxios.Gaxios, accessToken: string): SheetsClient {
  const auth = new OAuth2Client({ transporter });
  auth.setCredentials({ access_token: accessToken });
  // @googleapis/sheets bundles its own google-auth-library copy; the clients are
  // structurally identical but nominally distinct, so the auth handle crosses here as-is.
  return sheetsApi({ version: 'v4', auth: auth as unknown as sheets_v4.Options['auth'] });
}

function httpStatus(err: unknown): number | null {
  if (err instanceof gaxios.GaxiosError) {
    const status = err.status ?? err.response?.status;
    if (typeof status === 'number') return status;
  }
  return null;
}

function isInvalidGrant(err: unknown): boolean {
  if (!(err instanceof gaxios.GaxiosError)) return false;
  const data = err.response?.data as { error?: unknown } | undefined;
  if (data !== undefined && data !== null && data.error === 'invalid_grant') return true;
  return err.message.includes('invalid_grant');
}

export function translateSheets(err: unknown, context: string): never {
  const status = httpStatus(err);
  if (status === 401 || status === 403) throw new ResourceValidationError(`${context}: access was refused`);
  if (status === 404) throw new ResourceValidationError(`${context}: the spreadsheet is unavailable`);
  if (status === 429 || (status !== null && status >= 500)) throw new ProviderRequestError(`${context}: provider unavailable`, true);
  if (status !== null) throw new ProviderRequestError(`${context}: request rejected`, false);
  throw new ProviderRequestError(`${context}: provider request failed`, true);
}

export function translateToken(err: unknown): never {
  if (isInvalidGrant(err)) throw new ReauthorizationRequiredError();
  const status = httpStatus(err);
  const retryable = status === null || status === 429 || status >= 500;
  throw new ProviderRequestError(`google token endpoint returned HTTP ${status ?? 'error'}`, retryable);
}

export function translateValidate(err: unknown): never {
  const status = httpStatus(err);
  if (status === 404 || status === 403) throw new ResourceValidationError('that file is not accessible with this connection');
  throw new ProviderRequestError('could not validate the file', true);
}
