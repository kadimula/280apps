import { createHash, randomBytes } from 'node:crypto';
import {
  ProviderRequestError,
  ReauthorizationRequiredError,
  ResourceValidationError,
  type Authorization,
  type AuthorizeRequest,
  type CredentialPayload,
  type Exchanged,
  type ExchangeRequest,
  type OperationInput,
  type Provider,
  type ValidatedResource,
} from '../provider.js';
import { httpRequest, parseJson } from './http.js';
import { appendValues, readValues, updateValues } from './sheets.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILE = 'https://www.googleapis.com/drive/v3/files';

const SHEETS_CAPABILITY = 'google-sheets';
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];

export interface GoogleProviderOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export class GoogleWorkspaceProvider implements Provider {
  readonly name = 'google';
  readonly capabilities = [SHEETS_CAPABILITY] as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleProviderOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  authorize({ state, redirectUri }: AuthorizeRequest): Authorization {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { authUrl: `${AUTH_ENDPOINT}?${params.toString()}`, verifier };
  }

  async exchange({ code, redirectUri, verifier }: ExchangeRequest): Promise<Exchanged> {
    const body = await this.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    const idToken = strClaim(body.id_token);
    const account = accountFromIdToken(idToken);
    const refreshToken = strClaim(body.refresh_token);
    return {
      credential: credentialFrom(body, refreshToken),
      account,
    };
  }

  async refresh(cred: CredentialPayload): Promise<CredentialPayload> {
    if (cred.refreshToken === '') throw new ReauthorizationRequiredError();
    const body = await this.token({ grant_type: 'refresh_token', refresh_token: cred.refreshToken });
    return credentialFrom(body, strClaim(body.refresh_token));
  }

  async revoke(cred: CredentialPayload): Promise<void> {
    const token = cred.refreshToken !== '' ? cred.refreshToken : cred.accessToken;
    if (token === '') return;
    const res = await httpRequest(this.fetchImpl, REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (res.status >= 500) throw new ProviderRequestError('revocation failed', true);
  }

  async validateResource(capability: string, accessToken: string, externalId: string): Promise<ValidatedResource> {
    if (capability !== SHEETS_CAPABILITY) throw new ResourceValidationError('unsupported capability');
    const url = `${DRIVE_FILE}/${encodeURIComponent(externalId)}?fields=id,name,mimeType&supportsAllDrives=true`;
    const res = await httpRequest(this.fetchImpl, url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 403) {
      throw new ResourceValidationError('that file is not accessible with this connection');
    }
    if (res.status < 200 || res.status >= 300) throw new ProviderRequestError('could not validate the file', true);
    const body = parseJson(res.text);
    if (strClaim(body.mimeType) !== SPREADSHEET_MIME) {
      throw new ResourceValidationError('that file is not a Google spreadsheet');
    }
    return {
      externalId: strClaim(body.id) || externalId,
      displayName: strClaim(body.name),
    };
  }

  async runOperation(input: OperationInput, accessToken: string): Promise<Record<string, unknown>> {
    if (input.capability !== SHEETS_CAPABILITY) throw new ProviderRequestError('unsupported capability', false);
    const range = strClaim(input.body.range);
    switch (input.operation) {
      case 'read':
        return readValues(this.fetchImpl, accessToken, input.externalId, range);
      case 'append':
        return appendValues(this.fetchImpl, accessToken, input.externalId, range, valuesOf(input.body));
      case 'update':
        return updateValues(this.fetchImpl, accessToken, input.externalId, range, valuesOf(input.body));
      default:
        throw new ProviderRequestError('unsupported operation', false);
    }
  }

  private async token(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await httpRequest(this.fetchImpl, TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        ...fields,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    const body = parseJson(res.text);
    if (res.status < 200 || res.status >= 300) {
      if (strClaim(body.error) === 'invalid_grant') throw new ReauthorizationRequiredError();
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderRequestError(`google token endpoint returned HTTP ${res.status}`, retryable);
    }
    return body;
  }
}

function credentialFrom(body: Record<string, unknown>, refreshToken: string): CredentialPayload {
  const accessToken = strClaim(body.access_token);
  if (accessToken === '') throw new ProviderRequestError('google returned no access token', false);
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
  return {
    refreshToken,
    accessToken,
    accessTokenExpiresAt: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0,
  };
}

function accountFromIdToken(idToken: string): { label: string } {
  const payload = idToken.split('.')[1];
  if (payload === undefined) return { label: '' };
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return { label: strClaim(claims.email) };
  } catch {
    return { label: '' };
  }
}

function valuesOf(body: Record<string, unknown>): unknown[][] {
  const values = body.values;
  if (!Array.isArray(values)) return [];
  return values.filter((row): row is unknown[] => Array.isArray(row));
}

function strClaim(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}
