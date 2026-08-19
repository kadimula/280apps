export interface CredentialPayload {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
}

export interface AuthorizeRequest {
  state: string;
  redirectUri: string;
}

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
  label: string;
}

export interface Exchanged {
  credential: CredentialPayload;
  account: ProviderAccount;
}

export interface ValidatedResource {
  externalId: string;
  displayName: string;
}

export interface OperationInput {
  capability: string;
  operation: string;
  externalId: string;
  body: Record<string, unknown>;
}

export interface BrowseItem {
  id: string;
  name: string;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: readonly string[];
  authorize(req: AuthorizeRequest): Authorization;
  exchange(req: ExchangeRequest): Promise<Exchanged>;
  refresh(cred: CredentialPayload): Promise<CredentialPayload>;
  revoke(cred: CredentialPayload): Promise<void>;
  validateResource(capability: string, accessToken: string, externalId: string): Promise<ValidatedResource>;
  runOperation(input: OperationInput, accessToken: string): Promise<Record<string, unknown>>;
  // Server-side resource discovery for providers whose objects are enumerated from a
  // management API rather than a client-side picker. Absent means the app selects via
  // a token-scoped picker instead (see selectorSession).
  browse?(capability: string, accessToken: string, params: Record<string, string>): Promise<{ items: BrowseItem[] }>;
}

export class ReauthorizationRequiredError extends Error {
  constructor(message = 'the integration must be reconnected') {
    super(message);
    this.name = 'ReauthorizationRequiredError';
  }
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export class ResourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceValidationError';
  }
}
