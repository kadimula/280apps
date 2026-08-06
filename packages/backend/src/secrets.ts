import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const VERSION = 1;

interface SealedBytes {
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface Envelope {
  version: number;
  keyId: string;
  wrappedKey: SealedBytes;
  value: SealedBytes;
}

export interface SecretCipher {
  protect(appId: string, name: string, value: string): string;
  reveal(appId: string, name: string, envelope: string): string;
}

export class EnvelopeSecretCipher implements SecretCipher {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(encodedKey: string, keyId?: string) {
    this.key = decodeKey(encodedKey);
    this.keyId = keyId?.trim() || createHash('sha256').update(this.key).digest('hex').slice(0, 16);
  }

  protect(appId: string, name: string, value: string): string {
    const dataKey = randomBytes(KEY_BYTES);
    try {
      const envelope: Envelope = {
        version: VERSION,
        keyId: this.keyId,
        wrappedKey: seal(dataKey, this.key, keyAad(this.keyId)),
        value: seal(Buffer.from(value, 'utf8'), dataKey, valueAad(appId, name, this.keyId)),
      };
      return JSON.stringify(envelope);
    } finally {
      dataKey.fill(0);
    }
  }

  reveal(appId: string, name: string, encodedEnvelope: string): string {
    const envelope = parseEnvelope(encodedEnvelope);
    if (envelope.keyId !== this.keyId) {
      throw new Error(`secret envelope uses unavailable key ${envelope.keyId}`);
    }
    const dataKey = open(envelope.wrappedKey, this.key, keyAad(envelope.keyId));
    try {
      return open(envelope.value, dataKey, valueAad(appId, name, envelope.keyId)).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }
}

function seal(plaintext: Buffer, key: Buffer, aad: Buffer): SealedBytes {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function open(value: SealedBytes, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, fromBase64(value.nonce));
  decipher.setAAD(aad);
  decipher.setAuthTag(fromBase64(value.tag));
  return Buffer.concat([decipher.update(fromBase64(value.ciphertext)), decipher.final()]);
}

function parseEnvelope(value: string): Envelope {
  const parsed = JSON.parse(value) as Partial<Envelope>;
  if (
    parsed.version !== VERSION ||
    typeof parsed.keyId !== 'string' ||
    !sealedBytes(parsed.wrappedKey) ||
    !sealedBytes(parsed.value)
  ) {
    throw new Error('secret envelope is not valid');
  }
  return parsed as Envelope;
}

function sealedBytes(value: unknown): value is SealedBytes {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<SealedBytes>;
  return (
    typeof candidate.nonce === 'string' &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.tag === 'string'
  );
}

function decodeKey(value: string): Buffer {
  const key = fromBase64(value.trim());
  if (key.byteLength !== KEY_BYTES) {
    throw new Error('TWO80_SECRET_ENCRYPTION_KEY must be a base64 encoded 32 byte key');
  }
  return key;
}

function fromBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('invalid base64');
  }
  return Buffer.from(value, 'base64');
}

function keyAad(keyId: string): Buffer {
  return Buffer.from(JSON.stringify(['280-secret-key', VERSION, keyId]), 'utf8');
}

function valueAad(appId: string, name: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify(['280-secret-value', VERSION, keyId, appId, name]), 'utf8');
}
