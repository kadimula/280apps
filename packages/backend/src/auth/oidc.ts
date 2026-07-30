// The OIDC provider seam and its one production implementation (Google). Injected
// like the store and runtime, so tests drive a fake provider in-process; a second
// provider is one more implementation and one more entry in the provider map.

// `subject` is the provider's stable, opaque handle for the user (Google's `sub`),
// never their email, so a changed address does not fork the account.
export interface OidcIdentity {
  subject: string;
  email: string;
  name: string;
  image: string;
}

// OidcProvider is one identity provider. redirectUri is the backend's own callback
// and must be byte-identical between authUrl and exchange, so the caller builds it
// once and passes it to both.
export interface OidcProvider {
  readonly name: string;
  authUrl(opts: { state: string; redirectUri: string }): string;
  exchange(opts: { code: string; redirectUri: string }): Promise<OidcIdentity>;
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  // Injectable so a test exercises the real provider without a network.
  fetch?: typeof fetch;
}

// GoogleProvider speaks the OIDC authorization-code flow to Google. The id_token
// arrives over TLS straight from Google's token endpoint, so its payload is decoded
// rather than signature-verified: forging it would require holding TLS to google.com.
export class GoogleProvider implements OidcProvider {
  readonly name = 'google';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetch: typeof fetch;

  constructor(opts: GoogleOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  authUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      // Let a user on a shared machine pick which Google account signs in.
      prompt: 'select_account',
    });
    return `${GOOGLE_AUTH}?${params.toString()}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OidcIdentity> {
    const res = await this.fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`google token exchange failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) {
      throw new Error('google token response carried no id_token');
    }
    const claims = decodeJwtPayload(body.id_token);
    const subject = strClaim(claims.sub);
    const email = strClaim(claims.email);
    if (subject === '' || email === '') {
      throw new Error('google id_token missing sub or email');
    }
    return {
      subject,
      email,
      name: strClaim(claims.name),
      image: strClaim(claims.picture),
    };
  }
}

const ENTRA_BASE = 'https://login.microsoftonline.com';

export interface EntraOptions {
  clientId: string;
  clientSecret: string;
  // "organizations" is the multi-tenant work/school endpoint (each customer's
  // admin consents once); the default.
  tenant?: string;
  fetch?: typeof fetch;
}

// The same OIDC authorization-code flow as GoogleProvider, against Microsoft
// Entra. Like Google, the id_token is decoded rather than signature-verified (TLS
// to the token endpoint is the trust; see GoogleProvider).
export class EntraProvider implements OidcProvider {
  readonly name = 'microsoft';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenant: string;
  private readonly fetch: typeof fetch;

  constructor(opts: EntraOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tenant = opts.tenant && opts.tenant !== '' ? opts.tenant : 'organizations';
    this.fetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private authEndpoint(): string {
    return `${ENTRA_BASE}/${this.tenant}/oauth2/v2.0/authorize`;
  }

  private tokenEndpoint(): string {
    return `${ENTRA_BASE}/${this.tenant}/oauth2/v2.0/token`;
  }

  authUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      // Callback shape identical to Google's, so one handler reads both.
      response_mode: 'query',
      prompt: 'select_account',
    });
    return `${this.authEndpoint()}?${params.toString()}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OidcIdentity> {
    const res = await this.fetch(this.tokenEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'openid email profile',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`entra token exchange failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) {
      throw new Error('entra token response carried no id_token');
    }
    const claims = decodeJwtPayload(body.id_token);
    const subject = strClaim(claims.sub);
    // Entra puts the work address in `email` or, failing that, `preferred_username`/`upn`.
    const email = firstNonEmpty(strClaim(claims.email), strClaim(claims.preferred_username), strClaim(claims.upn));
    if (subject === '' || email === '') {
      throw new Error('entra id_token missing sub or email');
    }
    return {
      subject,
      email,
      name: strClaim(claims.name),
      image: '',
    };
  }
}

function firstNonEmpty(...vals: string[]): string {
  for (const v of vals) {
    if (v !== '') return v;
  }
  return '';
}

// Reads the middle segment of a JWT as JSON. It does not verify the signature
// (see the class note); a malformed token throws.
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object') throw new Error('id_token payload is not an object');
  return parsed as Record<string, unknown>;
}

function strClaim(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
