import { createHash, randomBytes } from 'node:crypto';
import {
  ProviderRequestError,
  ReauthorizationRequiredError,
  ResourceValidationError,
  type Authorization,
  type AuthorizeRequest,
  type BrowseItem,
  type CredentialPayload,
  type Exchanged,
  type ExchangeRequest,
  type OperationInput,
  type Provider,
  type ValidatedResource,
} from '../provider.js';
import { ApiKeyCache, ManagementStatusError, managementGet, tokenRequest, type FetchImpl, type TokenResult } from './client.js';
import {
  RestStatusError,
  deleteRows,
  insertRows,
  selectRows,
  translateRest,
  updateRows,
  type Filter,
  type RestTarget,
} from './tables.js';

const CAPABILITY = 'supabase-tables';
const MANAGEMENT_BASE = 'https://api.supabase.com';
const REQUEST_TIMEOUT_MS = 10_000;
const REF_RE = /^[a-z0-9]{20}$/;
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const DEFAULT_LIMIT = 100;

export interface SupabaseProviderOptions {
  clientId: string;
  clientSecret: string;
  fetch?: FetchImpl;
}

interface TableRef {
  ref: string;
  schema: string;
  table: string;
}

export class SupabaseProvider implements Provider {
  readonly name = 'supabase';
  readonly capabilities = [CAPABILITY] as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: FetchImpl;
  private readonly apiKeys: ApiKeyCache;

  constructor(opts: SupabaseProviderOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.apiKeys = new ApiKeyCache(this.fetchImpl);
  }

  authorize({ state, redirectUri }: AuthorizeRequest): Authorization {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { authUrl: `${MANAGEMENT_BASE}/v1/oauth/authorize?${params.toString()}`, verifier };
  }

  async exchange({ code, redirectUri, verifier }: ExchangeRequest): Promise<Exchanged> {
    const token = await tokenRequest(this.fetchImpl, this.clientId, this.clientSecret, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    return { credential: credentialFrom(token), account: { label: await this.accountLabel(token.accessToken) } };
  }

  async refresh(cred: CredentialPayload): Promise<CredentialPayload> {
    if (cred.refreshToken === '') throw new ReauthorizationRequiredError();
    const token = await tokenRequest(this.fetchImpl, this.clientId, this.clientSecret, {
      grant_type: 'refresh_token',
      refresh_token: cred.refreshToken,
    });
    return credentialFrom(token);
  }

  async revoke(cred: CredentialPayload): Promise<void> {
    const token = cred.refreshToken !== '' ? cred.refreshToken : cred.accessToken;
    if (token === '') return;
    try {
      const res = await this.fetchImpl(`${MANAGEMENT_BASE}/v1/oauth/revoke`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ refresh_token: token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status >= 500) throw new ProviderRequestError('revocation failed', true);
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError('revocation failed', true);
    }
  }

  async browse(capability: string, accessToken: string, params: Record<string, string>): Promise<{ items: BrowseItem[] }> {
    if (capability !== CAPABILITY) throw new ResourceValidationError('unsupported capability');
    const kind = params.kind ?? '';
    if (kind === 'projects') {
      const projects = await this.listProjects(accessToken);
      return { items: projects.map((p) => ({ id: p.ref, name: p.name })) };
    }
    if (kind === 'tables') {
      const ref = params.project ?? '';
      if (!REF_RE.test(ref)) throw new ResourceValidationError('that project reference is invalid');
      const tables = await this.listTables(ref, accessToken);
      return { items: tables.map((table) => ({ id: encodeExternalId({ ref, schema: 'public', table }), name: table })) };
    }
    throw new ResourceValidationError('unknown browse kind');
  }

  async validateResource(capability: string, accessToken: string, externalId: string): Promise<ValidatedResource> {
    if (capability !== CAPABILITY) throw new ResourceValidationError('unsupported capability');
    const target = parseExternalId(externalId);
    const project = await this.project(target.ref, accessToken);
    const key = await this.apiKeys.secretKey(target.ref, accessToken);
    if (!(await this.listTablesWithKey(target.ref, key)).includes(target.table)) {
      throw new ResourceValidationError('that table is unavailable');
    }
    return { externalId: encodeExternalId(target), displayName: `${project.name} · ${target.table}` };
  }

  async runOperation(input: OperationInput, accessToken: string): Promise<Record<string, unknown>> {
    if (input.capability !== CAPABILITY) throw new ProviderRequestError('unsupported capability', false);
    const target: RestTarget = parseExternalId(input.externalId);
    return this.withKey(target.ref, accessToken, (key) => this.dispatch(input, key, target));
  }

  private async dispatch(input: OperationInput, key: string, target: RestTarget): Promise<Record<string, unknown>> {
    const body = input.body;
    switch (input.operation) {
      case 'select':
        return selectRows(this.fetchImpl, key, target, {
          columns: asStringArray(body.columns),
          filters: asFilters(body.filters),
          limit: typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT,
        });
      case 'insert':
        return insertRows(this.fetchImpl, key, target, asArray(body.rows));
      case 'update':
        return updateRows(this.fetchImpl, key, target, asRecord(body.values), asFilters(body.filters));
      case 'delete':
        return deleteRows(this.fetchImpl, key, target, asFilters(body.filters));
      default:
        throw new ProviderRequestError('unsupported operation', false);
    }
  }

  // Runs fn with the project's cached secret key; on a REST auth rejection the key is
  // evicted and refetched once, covering a rotated or lapsed service key.
  private async withKey(
    ref: string,
    accessToken: string,
    fn: (key: string) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const key = await this.apiKeys.secretKey(ref, accessToken);
    try {
      return await fn(key);
    } catch (err) {
      if (err instanceof RestStatusError && (err.status === 401 || err.status === 403)) {
        this.apiKeys.evict(ref);
        const fresh = await this.apiKeys.secretKey(ref, accessToken);
        try {
          return await fn(fresh);
        } catch (retryErr) {
          if (retryErr instanceof RestStatusError) translateRest(retryErr);
          throw retryErr;
        }
      }
      if (err instanceof RestStatusError) translateRest(err);
      throw err;
    }
  }

  private async accountLabel(accessToken: string): Promise<string> {
    try {
      const orgs = await managementGet<Array<{ name?: unknown }>>(this.fetchImpl, accessToken, '/v1/organizations');
      const first = orgs[0];
      return typeof first?.name === 'string' ? first.name : '';
    } catch {
      return '';
    }
  }

  private async listProjects(accessToken: string): Promise<Array<{ ref: string; name: string }>> {
    const projects = await managementGet<Array<{ id?: unknown; name?: unknown }>>(this.fetchImpl, accessToken, '/v1/projects');
    return projects
      .map((p) => ({ ref: typeof p.id === 'string' ? p.id : '', name: typeof p.name === 'string' ? p.name : '' }))
      .filter((p) => p.ref !== '');
  }

  private async project(ref: string, accessToken: string): Promise<{ name: string }> {
    try {
      const p = await managementGet<{ name?: unknown }>(this.fetchImpl, accessToken, `/v1/projects/${ref}`);
      return { name: typeof p.name === 'string' ? p.name : '' };
    } catch (err) {
      if (err instanceof ManagementStatusError) throw new ResourceValidationError('that project is unavailable');
      throw err;
    }
  }

  private async listTables(ref: string, accessToken: string): Promise<string[]> {
    const key = await this.apiKeys.secretKey(ref, accessToken);
    return this.listTablesWithKey(ref, key);
  }

  private async listTablesWithKey(ref: string, key: string): Promise<string[]> {
    const openapi = await this.fetchOpenApi(ref, key);
    const paths = openapi.paths ?? {};
    return Object.keys(paths)
      .filter((p) => p !== '/' && !p.startsWith('/rpc/'))
      .map((p) => p.replace(/^\//, ''))
      .filter((name) => NAME_RE.test(name))
      .sort();
  }

  private async fetchOpenApi(ref: string, key: string): Promise<{ paths?: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${ref}.supabase.co/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderRequestError('the data API is unreachable', true);
    }
    if (res.status === 401 || res.status === 403) throw new ResourceValidationError('access to the project was refused');
    if (!res.ok) throw new ProviderRequestError(`the data API returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    return (await res.json()) as { paths?: Record<string, unknown> };
  }
}

function credentialFrom(token: TokenResult): CredentialPayload {
  return { refreshToken: token.refreshToken, accessToken: token.accessToken, accessTokenExpiresAt: token.expiresAtSecs };
}

function encodeExternalId(t: TableRef): string {
  return JSON.stringify({ ref: t.ref, schema: t.schema, table: t.table });
}

function parseExternalId(raw: string): TableRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ResourceValidationError('that table reference is invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ResourceValidationError('that table reference is invalid');
  }
  const o = parsed as Record<string, unknown>;
  const ref = typeof o.ref === 'string' ? o.ref : '';
  const schema = typeof o.schema === 'string' ? o.schema : '';
  const table = typeof o.table === 'string' ? o.table : '';
  if (!REF_RE.test(ref) || !NAME_RE.test(schema) || !NAME_RE.test(table)) {
    throw new ResourceValidationError('that table reference is invalid');
  }
  return { ref, schema, table };
}

function asFilters(v: unknown): Filter[] {
  return Array.isArray(v) ? (v as Filter[]) : [];
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? (v as string[]) : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
