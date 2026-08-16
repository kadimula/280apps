// The provider seam: a small discriminated contract every integration adapter
// implements. Adapters own external protocol details only — no store, Hono, or SQL
// dependency. The generic core (service.ts) owns credential persistence, refresh
// coordination, and authorization; it hands adapters a live access token for every
// operation that spends one.

// The provider-opaque credential the core stores encrypted. Only the adapter that
// produced it interprets its fields.
export interface CredentialPayload {
  refreshToken: string;
  accessToken: string;
  // Epoch seconds; 0 when unknown (forces a refresh before first use).
  accessTokenExpiresAt: number;
  tokenType: string;
  grantedScopes: string[];
}

export interface AuthorizeRequest {
  state: string;
  redirectUri: string;
}

// The adapter returns the consent URL and the PKCE verifier the core stores encrypted
// against the one-time state, to be handed back at exchange.
export interface Authorization {
  authUrl: string;
  verifier: string;
}

export interface ExchangeRequest {
  code: string;
  redirectUri: string;
  verifier: string;
}

export interface ProviderAccount {
  id: string;
  label: string;
}

export interface Exchanged {
  credential: CredentialPayload;
  account: ProviderAccount;
}

export interface ValidatedResource {
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

export interface OperationInput {
  capability: string;
  operation: string;
  externalId: string;
  body: Record<string, unknown>;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: readonly string[];
  authorize(req: AuthorizeRequest): Authorization;
  exchange(req: ExchangeRequest): Promise<Exchanged>;
  // Returns fresh credential material. A missing refresh token in the result means
  // "unchanged"; the core preserves the stored one. Throws ReauthorizationRequiredError
  // when the grant is permanently invalid.
  refresh(cred: CredentialPayload): Promise<CredentialPayload>;
  // Best-effort: the core swallows failures during disconnect.
  revoke(cred: CredentialPayload): Promise<void>;
  validateResource(capability: string, accessToken: string, externalId: string): Promise<ValidatedResource>;
  runOperation(input: OperationInput, accessToken: string): Promise<Record<string, unknown>>;
}

// The grant is permanently invalid (Google invalid_grant); the connection moves to
// reauthorization_required and the owner must reconnect.
export class ReauthorizationRequiredError extends Error {
  constructor(message = 'the integration must be reconnected') {
    super(message);
    this.name = 'ReauthorizationRequiredError';
  }
}

// A transient or fatal provider failure. retryable marks the transient case so the
// SDK surface returns a stable unavailable response the caller can retry.
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

// The selected external resource failed validation (wrong type, or access removed).
export class ResourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceValidationError';
  }
}
