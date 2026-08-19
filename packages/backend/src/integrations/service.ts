import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { VerifiedIdentity } from '@280/contracts/identity';
import { IntegrationStatus, type IntegrationConnection, type Store } from '../seams.js';
import type { SecretCipher } from '../secrets.js';
import {
  ProviderRequestError,
  ReauthorizationRequiredError,
  ResourceValidationError,
  type BrowseItem,
  type CredentialPayload,
  type Provider,
} from './provider.js';
import { ProviderRegistry, UnknownProviderError } from './registry.js';
import type { SdkIdentityVerifier } from './sdk-identity.js';

const OAUTH_ATTEMPT_TTL_SECS = 10 * 60;
const REFRESH_MARGIN_SECS = 60;
const ALIAS_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

const OPERATIONS: Record<string, Set<string>> = {
  'google-sheets': new Set(['read', 'append', 'update', 'deleteRows']),
  'supabase-tables': new Set(['select', 'insert', 'update', 'delete']),
};
const MAX_RANGE_LEN = 256;
const MAX_ROWS = 1000;
const MAX_CELLS = 10_000;

const SUPABASE_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const SUPABASE_FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is']);
const MAX_FILTERS = 16;
const MAX_IN_VALUES = 100;
const MAX_COLUMNS = 64;
const SELECT_DEFAULT_LIMIT = 100;
const SELECT_MAX_LIMIT = 1000;
const MAX_BROWSE_PARAMS = 8;
const MAX_BROWSE_VALUE_LEN = 128;

export type IntegrationErrorKind = 'bad_request' | 'not_found' | 'conflict' | 'unavailable';

export class IntegrationError extends Error {
  constructor(
    readonly kind: IntegrationErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export class SdkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}

export interface ConnectionView {
  id: string;
  provider: string;
  status: IntegrationStatus;
  account: string;
  updatedAt: number;
  resources: Array<{ id: string; capability: string; alias: string; displayName: string }>;
}

export interface SelectorSessionView {
  accessToken: string;
  expiresAt: number;
  pickerApiKey: string;
  projectNumber: string;
}

export interface IntegrationServiceConfig {
  apiOrigin: string;
  frontendOrigin: string;
  picker: { apiKey: string; projectNumber: string };
}

export interface IntegrationServiceDeps {
  store: Store;
  cipher: SecretCipher;
  registry: ProviderRegistry;
  identity: SdkIdentityVerifier;
  config: IntegrationServiceConfig;
  now?: () => number;
  randomId?: () => string;
  randomState?: () => string;
}

export class IntegrationService {
  private readonly store: Store;
  private readonly cipher: SecretCipher;
  private readonly registry: ProviderRegistry;
  private readonly identityVerifier: SdkIdentityVerifier;
  private readonly config: IntegrationServiceConfig;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomState: () => string;
  private readonly refreshLocks = new Map<string, Promise<CredentialPayload>>();

  constructor(deps: IntegrationServiceDeps) {
    this.store = deps.store;
    this.cipher = deps.cipher;
    this.registry = deps.registry;
    this.identityVerifier = deps.identity;
    this.config = deps.config;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomId = deps.randomId ?? (() => 'int_' + randomBytes(12).toString('hex'));
    this.randomState = deps.randomState ?? (() => randomBytes(32).toString('hex'));
  }

  catalog(): Array<{ provider: string; capabilities: string[] }> {
    return this.registry.list().map((p) => ({ provider: p.name, capabilities: [...p.capabilities] }));
  }

  async listConnections(appId: string): Promise<ConnectionView[]> {
    const conns = await this.store.connectionsByApp(appId);
    return Promise.all(
      conns.map(async (c) => ({
        id: c.id,
        provider: c.provider,
        status: c.status,
        account: c.accountLabel,
        updatedAt: c.updatedAt,
        resources: (await this.store.resourcesByConnection(c.id)).map((r) => ({
          id: r.id,
          capability: r.capability,
          alias: r.alias,
          displayName: r.displayName,
        })),
      })),
    );
  }

  async startConnection(input: {
    appId: string;
    provider: string;
    returnPath: string;
  }): Promise<{ authUrl: string; stateCookie: string }> {
    const provider = this.provider(input.provider);
    const state = this.randomState();
    const redirectUri = this.callbackUrl(provider.name);
    const { authUrl, verifier } = provider.authorize({ state, redirectUri });
    const payload = JSON.stringify({ verifier, returnPath: this.safePath(input.returnPath) });
    const payloadEnvelope = await this.cipher.protect(input.appId, attemptName(provider.name), payload);
    await this.store.createOAuthAttempt({
      stateHash: hash(state),
      appId: input.appId,
      provider: provider.name,
      payloadEnvelope,
      expiresAt: this.now() + OAUTH_ATTEMPT_TTL_SECS,
      consumedAt: 0,
    });
    return { authUrl, stateCookie: state };
  }

  async completeConnection(input: {
    provider: string;
    code: string;
    stateQuery: string;
    stateCookie: string;
  }): Promise<{ redirect: string }> {
    const provider = this.provider(input.provider);
    if (
      input.code === '' ||
      input.stateQuery === '' ||
      input.stateCookie === '' ||
      !constantTimeEqual(input.stateQuery, input.stateCookie)
    ) {
      throw new IntegrationError('bad_request', 'that connection could not be verified');
    }
    const attempt = await this.store.consumeOAuthAttempt(hash(input.stateCookie), this.now());
    if (attempt === null || attempt.provider !== provider.name) {
      throw new IntegrationError('bad_request', 'that connection request has expired');
    }

    const payload = decodePayload(await this.cipher.reveal(attempt.appId, attemptName(provider.name), attempt.payloadEnvelope));
    const existing = await this.store.connectionByProvider(attempt.appId, provider.name);

    let exchanged;
    try {
      exchanged = await provider.exchange({ code: input.code, redirectUri: this.callbackUrl(provider.name), verifier: payload.verifier });
    } catch (err) {
      throw this.asManagementError(err);
    }

    const credential = exchanged.credential;
    if (credential.refreshToken === '') {
      throw new IntegrationError('bad_request', 'the provider did not return offline access; reconnect and approve the request');
    }
    const envelope = await this.cipher.protect(attempt.appId, credName(provider.name), JSON.stringify(credential));
    await this.store.putConnection(
      {
        id: existing?.id ?? this.randomId(),
        appId: attempt.appId,
        provider: provider.name,
        accountLabel: exchanged.account.label || existing?.accountLabel || '',
        credentialEnvelope: envelope,
        status: IntegrationStatus.Active,
        createdAt: 0,
        updatedAt: 0,
      },
      existing !== null,
    );
    return { redirect: this.frontendRedirect(payload.returnPath) };
  }

  async selectorSession(appId: string, connectionId: string): Promise<SelectorSessionView> {
    const conn = await this.connectionOr(appId, connectionId);
    if (this.provider(conn.provider).browse !== undefined) {
      throw new IntegrationError('bad_request', 'this provider selects resources on the server');
    }
    let cred: CredentialPayload;
    try {
      cred = await this.liveCredential(conn);
    } catch (err) {
      throw this.asManagementError(err);
    }
    return {
      accessToken: cred.accessToken,
      expiresAt: cred.accessTokenExpiresAt,
      pickerApiKey: this.config.picker.apiKey,
      projectNumber: this.config.picker.projectNumber,
    };
  }

  async browseResources(input: {
    appId: string;
    connectionId: string;
    capability: string;
    params: Record<string, string>;
  }): Promise<{ items: BrowseItem[] }> {
    const conn = await this.connectionOr(input.appId, input.connectionId);
    const provider = this.provider(conn.provider);
    if (!provider.capabilities.includes(input.capability) || provider.browse === undefined) {
      throw new IntegrationError('bad_request', 'this connection does not support browsing resources');
    }
    const params = boundBrowseParams(input.params);
    try {
      const cred = await this.liveCredential(conn);
      return await provider.browse(input.capability, cred.accessToken, params);
    } catch (err) {
      throw this.asManagementError(err);
    }
  }

  async registerResource(input: {
    appId: string;
    connectionId: string;
    capability: string;
    alias: string;
    externalId: string;
  }): Promise<{ alias: string; capability: string; displayName: string }> {
    const conn = await this.connectionOr(input.appId, input.connectionId);
    const provider = this.provider(conn.provider);
    if (!provider.capabilities.includes(input.capability)) {
      throw new IntegrationError('bad_request', `this connection does not support ${input.capability}`);
    }
    const alias = input.alias.trim();
    if (!ALIAS_PATTERN.test(alias)) {
      throw new IntegrationError('bad_request', 'alias must be 1-64 letters, numbers, dot, dash, or underscore');
    }
    if (input.externalId.trim() === '') {
      throw new IntegrationError('bad_request', 'select a file to register');
    }

    let validated;
    try {
      const cred = await this.liveCredential(conn);
      validated = await provider.validateResource(input.capability, cred.accessToken, input.externalId.trim());
    } catch (err) {
      throw this.asManagementError(err);
    }

    await this.store.putResource({
      id: this.randomId(),
      connectionId: conn.id,
      appId: input.appId,
      capability: input.capability,
      alias,
      externalId: validated.externalId,
      displayName: validated.displayName,
      createdAt: 0,
      updatedAt: 0,
    });
    return { alias, capability: input.capability, displayName: validated.displayName };
  }

  async removeResource(appId: string, resourceId: string): Promise<boolean> {
    return this.store.deleteResource(appId, resourceId);
  }

  async disconnect(appId: string, connectionId: string): Promise<boolean> {
    const removed = await this.store.deleteConnection(appId, connectionId);
    if (removed === null) return false;
    try {
      await this.provider(removed.provider).revoke(await this.revealCredential(removed));
    } catch {
      // Revocation is best effort.
    }
    return true;
  }

  verifyIdentity(token: string): Promise<VerifiedIdentity> {
    return this.identityVerifier.verify(token);
  }

  async execute(input: { token: string; capability: string; operation: string; body: Record<string, unknown> }): Promise<Record<string, unknown>> {
    let identity: VerifiedIdentity;
    try {
      identity = await this.verifyIdentity(input.token);
    } catch {
      throw new SdkError('unauthenticated', 'the request identity is missing or invalid', 401);
    }
    if (identity.claims.anon === true) {
      throw new SdkError('forbidden', 'anonymous callers cannot use integrations', 403);
    }
    const appId = identity.claims.app;
    if (appId === '') throw new SdkError('forbidden', 'this identity is not bound to an app', 403);

    const ops = OPERATIONS[input.capability];
    if (ops === undefined || !ops.has(input.operation)) {
      throw new SdkError('invalid_request', 'unsupported capability or operation', 400);
    }
    let provider: Provider;
    try {
      provider = this.registry.forCapability(input.capability);
    } catch {
      throw new SdkError('invalid_request', 'unsupported capability', 400);
    }

    const conn = await this.store.connectionByProvider(appId, provider.name);
    if (conn === null) {
      throw new SdkError('not_connected', `no ${input.capability} connection is configured for this app`, 404);
    }
    if (conn.status === IntegrationStatus.ReauthorizationRequired) {
      throw new SdkError('reauthorization_required', 'the app owner must reconnect this integration', 409);
    }

    const alias = str(input.body.resource);
    if (alias === '') throw new SdkError('invalid_request', 'name a resource alias', 400);
    const resource = await this.store.resourceByAlias(appId, input.capability, alias);
    if (resource === null) {
      throw new SdkError('resource_not_found', `no resource is registered under "${alias}"`, 404);
    }

    const bounded = boundOperation(input.capability, input.operation, input.body);

    let cred: CredentialPayload;
    try {
      cred = await this.liveCredential(conn);
    } catch (err) {
      throw this.asSdkError(err);
    }
    try {
      return await provider.runOperation(
        { capability: input.capability, operation: input.operation, externalId: resource.externalId, body: bounded },
        cred.accessToken,
      );
    } catch (err) {
      throw this.asSdkError(err);
    }
  }

  private async connectionOr(appId: string, id: string): Promise<IntegrationConnection> {
    const conn = await this.store.connectionById(appId, id);
    if (conn === null) throw new IntegrationError('not_found', 'no such connection');
    return conn;
  }

  private provider(name: string): Provider {
    try {
      return this.registry.get(name);
    } catch (err) {
      if (err instanceof UnknownProviderError) throw new IntegrationError('bad_request', `unknown integration "${name}"`);
      throw err;
    }
  }

  private async liveCredential(conn: IntegrationConnection): Promise<CredentialPayload> {
    const cred = await this.revealCredential(conn);
    if (cred.accessToken !== '' && cred.accessTokenExpiresAt - REFRESH_MARGIN_SECS > this.now()) {
      return cred;
    }
    const inflight = this.refreshLocks.get(conn.id);
    if (inflight !== undefined) return inflight;
    const p = this.refreshCredential(conn, cred).finally(() => this.refreshLocks.delete(conn.id));
    this.refreshLocks.set(conn.id, p);
    return p;
  }

  private async revealCredential(conn: IntegrationConnection): Promise<CredentialPayload> {
    if (conn.credentialEnvelope === '') throw new ProviderRequestError('the connection has no stored credential', false);
    let plaintext: string;
    try {
      plaintext = await this.cipher.reveal(conn.appId, credName(conn.provider), conn.credentialEnvelope);
    } catch {
      throw new ProviderRequestError('the stored credential could not be read', false);
    }
    return decodeCredentialJson(plaintext);
  }

  private async refreshCredential(conn: IntegrationConnection, cred: CredentialPayload): Promise<CredentialPayload> {
    const provider = this.registry.get(conn.provider);
    let next: CredentialPayload;
    try {
      next = await provider.refresh(cred);
    } catch (err) {
      if (err instanceof ReauthorizationRequiredError) {
        await this.store.setConnectionStatus(conn.id, IntegrationStatus.ReauthorizationRequired);
      }
      throw err;
    }
    if (next.refreshToken === '') next = { ...next, refreshToken: cred.refreshToken };
    const envelope = await this.cipher.protect(conn.appId, credName(conn.provider), JSON.stringify(next));
    await this.store.updateConnectionCredential(conn.id, envelope);
    return next;
  }

  private asManagementError(err: unknown): IntegrationError {
    if (err instanceof IntegrationError) return err;
    if (err instanceof ReauthorizationRequiredError) return new IntegrationError('conflict', 'this connection must be reconnected');
    if (err instanceof ResourceValidationError) return new IntegrationError('bad_request', err.message);
    if (err instanceof ProviderRequestError) return new IntegrationError('unavailable', 'the provider is unavailable; try again');
    if (err instanceof UnknownProviderError) return new IntegrationError('bad_request', err.message);
    return new IntegrationError('unavailable', 'the request could not be completed');
  }

  private asSdkError(err: unknown): SdkError {
    if (err instanceof SdkError) return err;
    if (err instanceof ReauthorizationRequiredError) {
      return new SdkError('reauthorization_required', 'the app owner must reconnect this integration', 409);
    }
    if (err instanceof ResourceValidationError) return new SdkError('resource_unavailable', err.message, 409);
    if (err instanceof ProviderRequestError) {
      return err.retryable
        ? new SdkError('provider_unavailable', 'the provider is temporarily unavailable', 503, true)
        : new SdkError('provider_error', 'the provider rejected the request', 502);
    }
    return new SdkError('internal_error', 'the request could not be completed', 500);
  }

  private callbackUrl(provider: string): string {
    return `${this.config.apiOrigin.replace(/\/$/, '')}/integrations/${provider}/callback`;
  }

  private safePath(raw: string): string {
    return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
  }

  private frontendRedirect(path: string): string {
    return this.config.frontendOrigin.replace(/\/$/, '') + this.safePath(path);
  }
}

interface AttemptPayload {
  verifier: string;
  returnPath: string;
}

function decodePayload(raw: string): AttemptPayload {
  try {
    const parsed = JSON.parse(raw) as Partial<AttemptPayload>;
    return { verifier: str(parsed.verifier), returnPath: str(parsed.returnPath) };
  } catch {
    throw new IntegrationError('bad_request', 'that connection request is malformed');
  }
}

function decodeCredentialJson(raw: string): CredentialPayload {
  let parsed: Partial<CredentialPayload>;
  try {
    parsed = JSON.parse(raw) as Partial<CredentialPayload>;
  } catch {
    throw new ProviderRequestError('the stored credential is malformed', false);
  }
  return {
    refreshToken: str(parsed.refreshToken),
    accessToken: str(parsed.accessToken),
    accessTokenExpiresAt: typeof parsed.accessTokenExpiresAt === 'number' ? parsed.accessTokenExpiresAt : 0,
  };
}

function boundOperation(capability: string, operation: string, body: Record<string, unknown>): Record<string, unknown> {
  if (capability === 'supabase-tables') return boundSupabase(operation, body);
  return boundSheets(operation, body);
}

function boundSheets(operation: string, body: Record<string, unknown>): Record<string, unknown> {
  if (operation === 'deleteRows') return boundDelete(body);

  const range = str(body.range);
  if (range === '' || range.length > MAX_RANGE_LEN) {
    throw new SdkError('invalid_request', 'range must be a non-empty A1 range under 256 characters', 400);
  }
  if (operation === 'read') return { range };

  const rows = body.values;
  if (!Array.isArray(rows)) throw new SdkError('invalid_request', 'values must be an array of rows', 400);
  if (rows.length > MAX_ROWS) throw new SdkError('invalid_request', `values cannot exceed ${MAX_ROWS} rows`, 400);
  let cells = 0;
  const values: unknown[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) throw new SdkError('invalid_request', 'each row must be an array of cells', 400);
    cells += row.length;
    if (cells > MAX_CELLS) throw new SdkError('invalid_request', `values cannot exceed ${MAX_CELLS} cells`, 400);
    values.push(row);
  }
  return { range, values };
}

function boundDelete(body: Record<string, unknown>): Record<string, unknown> {
  const startRow = body.startRow;
  if (typeof startRow !== 'number' || !Number.isInteger(startRow) || startRow < 1) {
    throw new SdkError('invalid_request', 'startRow must be a positive one-based row number', 400);
  }
  const rowCount = body.rowCount;
  if (typeof rowCount !== 'number' || !Number.isInteger(rowCount) || rowCount < 1) {
    throw new SdkError('invalid_request', 'rowCount must be a positive integer', 400);
  }
  if (rowCount > MAX_ROWS) throw new SdkError('invalid_request', `rowCount cannot exceed ${MAX_ROWS}`, 400);
  return { sheet: normalizeSheet(body.sheet), startRow, rowCount };
}

function normalizeSheet(v: unknown): number | string {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) throw new SdkError('invalid_request', 'sheet index must be a non-negative integer', 400);
    return v;
  }
  if (typeof v === 'string') {
    if (v.trim() === '') throw new SdkError('invalid_request', 'sheet title cannot be empty', 400);
    return v;
  }
  throw new SdkError('invalid_request', 'sheet must be a title or a zero-based index', 400);
}

interface SupabaseFilter {
  column: string;
  op: string;
  value: unknown;
}

function boundSupabase(operation: string, body: Record<string, unknown>): Record<string, unknown> {
  switch (operation) {
    case 'select':
      return boundSelect(body);
    case 'insert':
      return boundInsert(body);
    case 'update':
      return boundUpdate(body);
    case 'delete':
      return { filters: parseFilters(body.filters, true) };
    default:
      throw new SdkError('invalid_request', 'unsupported operation', 400);
  }
}

function boundSelect(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { filters: parseFilters(body.filters, false), limit: parseLimit(body.limit) };
  if (body.columns !== undefined) out.columns = parseColumns(body.columns);
  return out;
}

function boundInsert(body: Record<string, unknown>): Record<string, unknown> {
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new SdkError('invalid_request', 'rows must be a non-empty array', 400);
  if (rows.length > MAX_ROWS) throw new SdkError('invalid_request', `rows cannot exceed ${MAX_ROWS}`, 400);
  let cells = 0;
  for (const row of rows) {
    cells += plainObjectKeys(row).length;
    if (cells > MAX_CELLS) throw new SdkError('invalid_request', `rows cannot exceed ${MAX_CELLS} cells`, 400);
  }
  return { rows };
}

function boundUpdate(body: Record<string, unknown>): Record<string, unknown> {
  const values = body.values;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new SdkError('invalid_request', 'values must be a non-empty object', 400);
  }
  const keys = plainObjectKeys(values);
  if (keys.length === 0) throw new SdkError('invalid_request', 'values must be a non-empty object', 400);
  if (keys.length > MAX_COLUMNS) throw new SdkError('invalid_request', `values cannot exceed ${MAX_COLUMNS} columns`, 400);
  return { values, filters: parseFilters(body.filters, true) };
}

function plainObjectKeys(row: unknown): string[] {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new SdkError('invalid_request', 'each row must be a plain object', 400);
  }
  const keys = Object.keys(row as Record<string, unknown>);
  for (const k of keys) if (!SUPABASE_COLUMN_RE.test(k)) throw new SdkError('invalid_request', `column "${k}" is invalid`, 400);
  return keys;
}

function parseColumns(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new SdkError('invalid_request', 'columns must be a non-empty array', 400);
  if (raw.length > MAX_COLUMNS) throw new SdkError('invalid_request', `columns cannot exceed ${MAX_COLUMNS}`, 400);
  return raw.map((c) => {
    if (typeof c !== 'string' || !SUPABASE_COLUMN_RE.test(c)) throw new SdkError('invalid_request', 'column name is invalid', 400);
    return c;
  });
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return SELECT_DEFAULT_LIMIT;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > SELECT_MAX_LIMIT) {
    throw new SdkError('invalid_request', `limit must be an integer between 1 and ${SELECT_MAX_LIMIT}`, 400);
  }
  return raw;
}

function parseFilters(raw: unknown, required: boolean): SupabaseFilter[] {
  if (raw === undefined) {
    if (required) throw new SdkError('invalid_request', 'at least one filter is required', 400);
    return [];
  }
  if (!Array.isArray(raw)) throw new SdkError('invalid_request', 'filters must be an array', 400);
  if (required && raw.length === 0) throw new SdkError('invalid_request', 'at least one filter is required', 400);
  if (raw.length > MAX_FILTERS) throw new SdkError('invalid_request', `filters cannot exceed ${MAX_FILTERS}`, 400);
  return raw.map(parseFilter);
}

function parseFilter(raw: unknown): SupabaseFilter {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SdkError('invalid_request', 'each filter must be an object', 400);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.column !== 'string' || !SUPABASE_COLUMN_RE.test(o.column)) {
    throw new SdkError('invalid_request', 'filter column is invalid', 400);
  }
  if (typeof o.op !== 'string' || !SUPABASE_FILTER_OPS.has(o.op)) {
    throw new SdkError('invalid_request', 'filter op is not supported', 400);
  }
  const value = o.value;
  if (o.op === 'is') {
    if (value !== null && value !== true && value !== false) {
      throw new SdkError('invalid_request', 'the "is" filter requires null, true, or false', 400);
    }
  } else if (o.op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
      throw new SdkError('invalid_request', `the "in" filter requires 1 to ${MAX_IN_VALUES} values`, 400);
    }
    for (const el of value) {
      if (!isScalar(el)) throw new SdkError('invalid_request', 'the "in" values must be strings, numbers, or booleans', 400);
    }
  } else if (o.op === 'like' || o.op === 'ilike') {
    if (typeof value !== 'string') throw new SdkError('invalid_request', `the "${o.op}" filter requires a string pattern`, 400);
  } else if (!isScalar(value)) {
    throw new SdkError('invalid_request', 'filter value must be a string, number, or boolean', 400);
  }
  return { column: o.column, op: o.op, value };
}

function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function boundBrowseParams(params: Record<string, string>): Record<string, string> {
  const entries = Object.entries(params);
  if (entries.length > MAX_BROWSE_PARAMS) throw new IntegrationError('bad_request', 'too many browse parameters');
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || typeof v !== 'string' || v.length > MAX_BROWSE_VALUE_LEN) {
      throw new IntegrationError('bad_request', 'browse parameters must be short strings');
    }
  }
  return params;
}

function attemptName(provider: string): string {
  return `integration-oauth:${provider}`;
}

function credName(provider: string): string {
  return `integration-credential:${provider}`;
}

function hash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export { ProviderRegistry };
