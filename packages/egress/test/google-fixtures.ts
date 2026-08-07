// Test fixtures for the Google service-account minter: a real RSA keypair generated
// with WebCrypto (so RS256 signing is verified deterministically against the public
// key, not mocked), a service-account JSON built from it, and a fake token endpoint +
// upstream fetch that records what it received.

const encoder = new TextEncoder();

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemFromPkcs8(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

export interface ServiceAccountFixture {
  json: string; // the opaque secret value the vault holds
  clientEmail: string;
  privateKeyPem: string;
  publicKey: CryptoKey; // verifies the minted assertion's RS256 signature
}

export async function makeServiceAccount(
  clientEmail = 'sa@proj.iam.gserviceaccount.com',
): Promise<ServiceAccountFixture> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const privateKeyPem = pemFromPkcs8(pkcs8);
  const json = JSON.stringify({
    type: 'service_account',
    project_id: 'proj',
    private_key_id: 'kid',
    private_key: privateKeyPem,
    client_email: clientEmail,
    token_uri: 'https://evil.example/token', // must be ignored; endpoint is hardcoded
  });
  return { json, clientEmail, privateKeyPem, publicKey: pair.publicKey };
}

export interface DecodedAssertion {
  valid: boolean;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export async function verifyAssertion(publicKey: CryptoKey, jwt: string): Promise<DecodedAssertion> {
  const [h, c, s] = jwt.split('.');
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    b64urlDecode(s ?? ''),
    encoder.encode(`${h}.${c}`),
  );
  return {
    valid,
    header: JSON.parse(new TextDecoder().decode(b64urlDecode(h ?? ''))),
    claims: JSON.parse(new TextDecoder().decode(b64urlDecode(c ?? ''))),
  };
}

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface TokenCall {
  grantType: string;
  assertion: string;
  redirect: string | undefined;
}

export interface FakeUpstreamOptions {
  // Response for the token endpoint. Defaults to a 200 minting `defaultToken`. A
  // function receives the call index (0-based) so a test can vary per attempt.
  tokenResponse?: (call: number) => Response | Promise<Response>;
  // Throw instead of responding at the token endpoint (network failure), by call index.
  tokenThrows?: (call: number) => boolean;
  // Response for the downstream (non-token) request. Defaults to 200 'downstream-ok'.
  downstreamResponse?: (call: number) => Response;
  defaultToken?: { access_token: string; expires_in: number };
}

// A fetch double that routes the token endpoint and the downstream API on one impl
// (the handler uses the same injected fetch for both the exchange and the forward).
export function fakeUpstream(opts: FakeUpstreamOptions = {}) {
  const tokenCalls: TokenCall[] = [];
  const downstreamCalls: { url: string; authorization: string | null }[] = [];
  const defaultToken = opts.defaultToken ?? { access_token: 'ya29.mock-access-token', expires_in: 3600 };

  const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const n = tokenCalls.length;
      const body =
        init?.body != null
          ? String(init.body)
          : input instanceof Request
            ? await input.text()
            : '';
      const params = new URLSearchParams(body);
      tokenCalls.push({
        grantType: params.get('grant_type') ?? '',
        assertion: params.get('assertion') ?? '',
        redirect: init?.redirect,
      });
      if (opts.tokenThrows?.(n)) throw new TypeError('network error');
      if (opts.tokenResponse) return opts.tokenResponse(n);
      return new Response(JSON.stringify({ ...defaultToken, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const n = downstreamCalls.length;
    const req = input instanceof Request ? input : new Request(url, init);
    downstreamCalls.push({ url, authorization: req.headers.get('authorization') });
    return opts.downstreamResponse?.(n) ?? new Response('downstream-ok', { status: 200 });
  }) as unknown as typeof fetch;

  return { tokenCalls, downstreamCalls, fetchImpl };
}

// The ctx.params for a google-service-account credential on a Sheets host.
export function googleParams(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app_1',
    host: 'sheets.googleapis.com',
    secret: 'GOOGLE_SA',
    type: 'google-service-account',
    header: 'authorization',
    scheme: 'Bearer',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    ...overrides,
  };
}
