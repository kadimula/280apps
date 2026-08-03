// The mint contract between the central gateway (GatewayRPC.mint) and the app-Worker
// middleware, carried over the service binding. Pure types + the JWKS shape; no
// implementation, so both sides share one definition and cannot drift.

export interface MintInput {
  sessionToken: string; // the 280_session cookie value ('' when absent)
  viewCookie: string; // the 280_view cookie value ('' when absent)
  script: string; // the app's stable script name
  host: string; // the app host, becomes the token audience
}

export type MintResult =
  // Admitted: a fresh identity token audience-scoped to `host`, valid `ttlSecs`.
  | { kind: 'token'; token: string; ttlSecs: number }
  // No session: the browser must sign in at this central login URL, then return.
  | { kind: 'login'; url: string }
  // Signed in but not permitted to open this app.
  | { kind: 'deny'; reason: string };

// The dashboard-preview mint: the grant is the opaque token the control plane
// issued (carried in ?g= on the bootstrap hop, then in the partitioned
// 280_preview cookie). Same MintResult; mintPreview never returns `login`.
export interface MintPreviewInput {
  grant: string;
  script: string; // the app's stable script name
  host: string; // the app host, becomes the token audience
}

export interface JwksDoc {
  keys: JsonWebKey[];
}

// The service-binding surface the app Worker calls. The central gateway's GatewayRPC
// implements it; the middleware depends only on this interface.
export interface GatewayBinding {
  mint(input: MintInput): Promise<MintResult>;
  mintPreview(input: MintPreviewInput): Promise<MintResult>;
  jwks(): Promise<JwksDoc>;
}
