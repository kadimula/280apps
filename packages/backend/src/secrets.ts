import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 2;

interface SealedBytes {
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface Envelope {
  version: number;
  keyId: string;
  wrappedKey: string;
  value: SealedBytes;
}

export interface SecretCipher {
  protect(appId: string, name: string, value: string): Promise<string>;
  reveal(appId: string, name: string, envelope: string): Promise<string>;
}

// KeyWrapper wraps and unwraps the per-value data key: locally with an AES master
// key, or remotely with Cloud KMS. The wrapped form is one opaque base64 blob.
export interface KeyWrapper {
  readonly keyId: string;
  wrap(dataKey: Buffer, aad: Buffer): Promise<string>;
  unwrap(wrapped: string, aad: Buffer): Promise<Buffer>;
}

export class EnvelopeSecretCipher implements SecretCipher {
  constructor(private readonly wrapper: KeyWrapper) {}

  async protect(appId: string, name: string, value: string): Promise<string> {
    const keyId = this.wrapper.keyId;
    const dataKey = randomBytes(KEY_BYTES);
    try {
      const envelope: Envelope = {
        version: VERSION,
        keyId,
        wrappedKey: await this.wrapper.wrap(dataKey, keyAad(keyId)),
        value: seal(Buffer.from(value, 'utf8'), dataKey, valueAad(appId, name, keyId)),
      };
      return JSON.stringify(envelope);
    } finally {
      dataKey.fill(0);
    }
  }

  async reveal(appId: string, name: string, encodedEnvelope: string): Promise<string> {
    const envelope = parseEnvelope(encodedEnvelope);
    if (envelope.keyId !== this.wrapper.keyId) {
      throw new Error(`secret envelope uses unavailable key ${envelope.keyId}`);
    }
    const dataKey = await this.wrapper.unwrap(envelope.wrappedKey, keyAad(envelope.keyId));
    try {
      return open(envelope.value, dataKey, valueAad(appId, name, envelope.keyId)).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }
}

// LocalKeyWrapper wraps data keys with an env-held AES master key: the dev-loop
// and self-host path. Production wraps through KmsKeyWrapper (kms.ts) instead.
export class LocalKeyWrapper implements KeyWrapper {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(encodedKey: string, keyId?: string) {
    this.key = decodeKey(encodedKey);
    this.keyId = keyId?.trim() || createHash('sha256').update(this.key).digest('hex').slice(0, 16);
  }

  wrap(dataKey: Buffer, aad: Buffer): Promise<string> {
    const sealed = seal(dataKey, this.key, aad);
    const packed = Buffer.concat([fromBase64(sealed.nonce), fromBase64(sealed.tag), fromBase64(sealed.ciphertext)]);
    return Promise.resolve(packed.toString('base64'));
  }

  unwrap(wrapped: string, aad: Buffer): Promise<Buffer> {
    const packed = fromBase64(wrapped);
    if (packed.byteLength <= NONCE_BYTES + TAG_BYTES) throw new Error('wrapped key is too short');
    const sealed: SealedBytes = {
      nonce: packed.subarray(0, NONCE_BYTES).toString('base64'),
      tag: packed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES).toString('base64'),
      ciphertext: packed.subarray(NONCE_BYTES + TAG_BYTES).toString('base64'),
    };
    return Promise.resolve(open(sealed, this.key, aad));
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
    typeof parsed.wrappedKey !== 'string' ||
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
    throw new Error('APP_SECRET_LOCAL_MASTER_KEY must be a base64 encoded 32 byte key');
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
