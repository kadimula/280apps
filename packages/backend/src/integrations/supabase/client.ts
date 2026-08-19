import { ProviderRequestError, ReauthorizationRequiredError, ResourceValidationError } from '../provider.js';

const MANAGEMENT_BASE = 'https://api.supabase.com';
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchImpl = typeof fetch;

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAtSecs: number;
}

// A management response the token/key seam cannot recover from (403/404): distinct
// from auth (401) and transient (429/5xx) so callers can map it to a resource error.
export class ManagementStatusError extends Error {
  constructor(readonly status: number) {
    super(`the management API returned HTTP ${status}`);
    this.name = 'ManagementStatusError';
  }
}

function basicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

export async function tokenRequest(
  fetchImpl: FetchImpl,
  clientId: string,
  clientSecret: string,
  params: Record<string, string>,
): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${MANAGEMENT_BASE}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderRequestError('the token endpoint is unreachable', true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    if ((res.status === 400 || res.status === 401) && body.error === 'invalid_grant') {
      throw new ReauthorizationRequiredError();
    }
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderRequestError(`the token endpoint returned HTTP ${res.status}`, retryable);
  }
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  if (accessToken === '') throw new ProviderRequestError('the token endpoint returned no access token', false);
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 0;
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expiresAtSecs: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

export async function managementGet<T>(fetchImpl: FetchImpl, accessToken: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${MANAGEMENT_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderRequestError('the management API is unreachable', true);
  }
  if (res.status === 401) throw new ReauthorizationRequiredError();
  if (res.status === 429 || res.status >= 500) {
    throw new ProviderRequestError(`the management API returned HTTP ${res.status}`, true);
  }
  if (!res.ok) throw new ManagementStatusError(res.status);
  return (await res.json()) as T;
}

interface CachedKey {
  key: string;
  expiresAt: number;
}

interface ApiKeyEntry {
  type?: unknown;
  name?: unknown;
  api_key?: unknown;
}

// Caches a project's secret API key behind single-flight fetches so concurrent
// operations reveal it once. Keys never appear in logs or errors.
export class ApiKeyCache {
  private readonly cache = new Map<string, CachedKey>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly fetchImpl: FetchImpl,
    private readonly ttlSecs = 300,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  secretKey(ref: string, accessToken: string): Promise<string> {
    const cached = this.cache.get(ref);
    if (cached !== undefined && cached.expiresAt > this.now()) return Promise.resolve(cached.key);
    const existing = this.inflight.get(ref);
    if (existing !== undefined) return existing;
    const p = this.reveal(ref, accessToken).finally(() => this.inflight.delete(ref));
    this.inflight.set(ref, p);
    return p;
  }

  evict(ref: string): void {
    this.cache.delete(ref);
  }

  private async reveal(ref: string, accessToken: string): Promise<string> {
    const keys = await managementGet<ApiKeyEntry[]>(this.fetchImpl, accessToken, `/v1/projects/${ref}/api-keys?reveal=true`);
    const key = pickSecretKey(keys);
    this.cache.set(ref, { key, expiresAt: this.now() + this.ttlSecs });
    return key;
  }
}

function pickSecretKey(keys: ApiKeyEntry[]): string {
  const chosen = keys.find((k) => k.type === 'secret') ?? keys.find((k) => k.name === 'service_role');
  const value = typeof chosen?.api_key === 'string' ? chosen.api_key : '';
  if (value === '') throw new ResourceValidationError('this project exposes no secret API key');
  return value;
}
