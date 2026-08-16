import { GoogleAuth } from 'google-auth-library';
import type { KeyWrapper } from './secrets.js';

const KMS_ENDPOINT = 'https://cloudkms.googleapis.com/v1';
const KMS_SCOPE = 'https://www.googleapis.com/auth/cloudkms';

export interface KmsDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
}

// KmsKeyWrapper wraps data keys with a Cloud KMS symmetric key. keyId is the full
// key resource name: stable across KMS key-version rotations, unique per environment.
export class KmsKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getToken: () => Promise<string>;

  constructor(keyName: string, credentialsJson: string, deps: KmsDeps = {}) {
    this.keyId = keyName;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.getToken = deps.getToken ?? googleTokenSource(credentialsJson);
  }

  async wrap(dataKey: Buffer, aad: Buffer): Promise<string> {
    const out = await this.call('encrypt', {
      plaintext: dataKey.toString('base64'),
      additionalAuthenticatedData: aad.toString('base64'),
    });
    if (typeof out.ciphertext !== 'string') throw new Error('KMS encrypt returned no ciphertext');
    return out.ciphertext;
  }

  async unwrap(wrapped: string, aad: Buffer): Promise<Buffer> {
    const out = await this.call('decrypt', {
      ciphertext: wrapped,
      additionalAuthenticatedData: aad.toString('base64'),
    });
    if (typeof out.plaintext !== 'string') throw new Error('KMS decrypt returned no plaintext');
    return Buffer.from(out.plaintext, 'base64');
  }

  private async call(action: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, unknown>> {
    const token = await this.getToken();
    const res = await this.fetchImpl(`${KMS_ENDPOINT}/${this.keyId}:${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`KMS ${action} failed with status ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

function googleTokenSource(credentialsJson: string): () => Promise<string> {
  const auth = new GoogleAuth({ credentials: parseCredentials(credentialsJson), scopes: [KMS_SCOPE] });
  return async () => {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('could not obtain a Google access token for KMS');
    return token;
  };
}

function parseCredentials(credentialsJson: string): Record<string, string> {
  try {
    return JSON.parse(credentialsJson) as Record<string, string>;
  } catch {
    throw new Error('APP_SECRET_KMS_CREDENTIALS_JSON is not valid JSON');
  }
}
