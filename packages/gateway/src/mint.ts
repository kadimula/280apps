// The mint contract between the central gateway and the app Worker, carried over the
// service binding. Pure types only, so both sides share one definition and cannot drift.

export interface MintInput {
  sessionToken: string; // 280_session cookie value ('' when absent)
  viewCookie: string; // 280_view cookie value ('' when absent)
  script: string;
  host: string; // becomes the token audience
}

export type MintResult =
  // Admitted: a fresh identity token audience-scoped to `host`, valid `ttlSecs`.
  | { kind: 'token'; token: string; ttlSecs: number }
  // No session: the browser must sign in at this central login URL, then return.
  | { kind: 'login'; url: string }
  // Signed in but not permitted to open this app.
  | { kind: 'deny'; reason: string };

// The dashboard-preview mint: the grant is an opaque control-plane token (carried in
// ?g= on the bootstrap hop, then the partitioned 280_preview cookie). Never `login`.
export interface MintPreviewInput {
  grant: string;
  script: string;
  host: string; // becomes the token audience
}

export interface JwksDoc {
  keys: JsonWebKey[];
}

// The service-binding surface the app Worker calls; GatewayRPC implements it.
export interface GatewayBinding {
  mint(input: MintInput): Promise<MintResult>;
  mintPreview(input: MintPreviewInput): Promise<MintResult>;
  jwks(): Promise<JwksDoc>;
}
