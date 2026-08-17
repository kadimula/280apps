import { createHash, randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client, gaxios, type Credentials } from 'google-auth-library';
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
import { makeTransporter, sheetsFor, translateToken, translateValidate, type FetchImpl } from './client.js';
import { appendValues, deleteRows, readValues, updateValues } from './sheets.js';

const DRIVE_FILE = 'https://www.googleapis.com/drive/v3/files';
const SHEETS_CAPABILITY = 'google-sheets';
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];

export interface GoogleProviderOptions {
  clientId: string;
  clientSecret: string;
  fetch?: FetchImpl;
}

export class GoogleWorkspaceProvider implements Provider {
  readonly name = 'google';
  readonly capabilities = [SHEETS_CAPABILITY] as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly transporter: gaxios.Gaxios;

  constructor(opts: GoogleProviderOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.transporter = makeTransporter(opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)));
  }

  authorize({ state, redirectUri }: AuthorizeRequest): Authorization {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authUrl = this.oauth().generateAuthUrl({
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: challenge,
    });
    return { authUrl, verifier };
  }

  async exchange({ code, redirectUri, verifier }: ExchangeRequest): Promise<Exchanged> {
    const { tokens } = await this.oauth()
      .getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri })
      .catch((err) => translateToken(err));
    return {
      credential: credentialFrom(tokens, strClaim(tokens.refresh_token)),
      account: accountFromIdToken(strClaim(tokens.id_token)),
    };
  }

  async refresh(cred: CredentialPayload): Promise<CredentialPayload> {
    if (cred.refreshToken === '') throw new ReauthorizationRequiredError();
    const client = this.oauth();
    client.setCredentials({ refresh_token: cred.refreshToken });
    const { credentials } = await client.refreshAccessToken().catch((err) => translateToken(err));
    return credentialFrom(credentials, strClaim(credentials.refresh_token));
  }

  async revoke(cred: CredentialPayload): Promise<void> {
    const token = cred.refreshToken !== '' ? cred.refreshToken : cred.accessToken;
    if (token === '') return;
    try {
      await this.oauth().revokeToken(token);
    } catch (err) {
      const status = err instanceof gaxios.GaxiosError ? (err.status ?? err.response?.status ?? null) : null;
      if (status === null || status >= 500) throw new ProviderRequestError('revocation failed', true);
    }
  }

  async validateResource(capability: string, accessToken: string, externalId: string): Promise<ValidatedResource> {
    if (capability !== SHEETS_CAPABILITY) throw new ResourceValidationError('unsupported capability');
    const client = this.oauth();
    client.setCredentials({ access_token: accessToken });
    const url = `${DRIVE_FILE}/${encodeURIComponent(externalId)}?fields=id,name,mimeType&supportsAllDrives=true`;
    const res = await client
      .request<{ id?: string; name?: string; mimeType?: string }>({ url })
      .catch((err) => translateValidate(err));
    if (res.data.mimeType !== SPREADSHEET_MIME) throw new ResourceValidationError('that file is not a Google spreadsheet');
    return { externalId: strClaim(res.data.id) || externalId, displayName: strClaim(res.data.name) };
  }

  async runOperation(input: OperationInput, accessToken: string): Promise<Record<string, unknown>> {
    if (input.capability !== SHEETS_CAPABILITY) throw new ProviderRequestError('unsupported capability', false);
    const api = sheetsFor(this.transporter, accessToken);
    const range = strClaim(input.body.range);
    switch (input.operation) {
      case 'read':
        return readValues(api, input.externalId, range);
      case 'append':
        return appendValues(api, input.externalId, range, valuesOf(input.body));
      case 'update':
        return updateValues(api, input.externalId, range, valuesOf(input.body));
      case 'deleteRows':
        return deleteRows(api, input.externalId, sheetSelector(input.body.sheet), numOf(input.body.startRow), numOf(input.body.rowCount));
      default:
        throw new ProviderRequestError('unsupported operation', false);
    }
  }

  private oauth(): OAuth2Client {
    return new OAuth2Client({ clientId: this.clientId, clientSecret: this.clientSecret, transporter: this.transporter });
  }
}

function credentialFrom(tokens: Credentials, refreshToken: string): CredentialPayload {
  const accessToken = strClaim(tokens.access_token);
  if (accessToken === '') throw new ProviderRequestError('google returned no access token', false);
  return {
    refreshToken,
    accessToken,
    accessTokenExpiresAt: typeof tokens.expiry_date === 'number' ? Math.floor(tokens.expiry_date / 1000) : 0,
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

function sheetSelector(v: unknown): number | string {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  return 0;
}

function numOf(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function valuesOf(body: Record<string, unknown>): unknown[][] {
  const values = body.values;
  if (!Array.isArray(values)) return [];
  return values.filter((row): row is unknown[] => Array.isArray(row));
}

function strClaim(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
