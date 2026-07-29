// The OIDC provider seam and its one production implementation (Google). It is
// an injected seam like the store and the runtime: the auth service depends on
// the interface, so tests drive a fake provider in-process and production drives
// the real one. Adding Microsoft later is a second implementation of this
// interface and one more entry in the provider map, nothing in the flow.

// OidcIdentity is what a provider tells us about the person who just signed in.
// `subject` is the provider's stable, opaque handle for the user (Google's
// `sub`), never their email, so a changed address does not fork the account.
export interface OidcIdentity {
  subject: string;
  email: string;
  name: string;
  image: string;
}

// OidcProvider is one identity provider. authUrl is where the browser is sent to
// approve; exchange trades the code the provider hands back for the identity.
// redirectUri is the backend's own callback and must be byte-identical between
// the two calls, which is why the auth service builds it once and passes it to
// both.
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
  // fetch is injectable so a test can exercise the real provider without a
  // network; production leaves it unset and gets the global.
  fetch?: typeof fetch;
}

// GoogleProvider speaks the OpenID Connect authorization-code flow to Google.
// The id_token comes back over TLS straight from Google's token endpoint, so its
// payload is decoded rather than signature-verified: nothing between us and
// Google could have forged it without also holding TLS to google.com.
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

// decodeJwtPayload reads the middle segment of a JWT as JSON. It does not verify
// the signature (see the class note); a malformed token throws, which the caller
// surfaces as a failed login.
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
