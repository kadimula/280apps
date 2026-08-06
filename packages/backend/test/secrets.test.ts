// The security contract: list and audit paths never return plaintext. An owner may
// explicitly reveal one value through the authenticated, non-cacheable reveal path.

import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  MANIFEST_KIND_CONTAINER,
  digestBytes,
  type Identity,
  type Manifest,
} from '@280/contracts';
import type { HonoEnv } from '../src/observe.js';
import type { SecretDelivery, Store } from '../src/seams.js';
import { EnvelopeSecretCipher, LocalKeyWrapper, type KeyWrapper } from '../src/secrets.js';
import { KmsKeyWrapper } from '../src/kms.js';
import { deliveryFailed } from '../src/secret-delivery.js';
import { bodyOf, bytesOf, newPlatform, newServer, type Harness } from './helpers/harness.js';
import { newAuth, signIn } from './helpers/auth.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

const ident = (over: Partial<Identity> = {}): Identity => ({
  appId: '',
  slug: 'renewals',
  framework: 'next',
  gitRemote: '',
  clientRef: 'ref1',
  forceNew: false,
  ...over,
});

function policyManifest(secrets: string[]): { manifest: Manifest; digest: string; body: Uint8Array } {
  const body = bytesOf(`FROM scratch\n# declares ${secrets.join(',')}\n`);
  const digest = digestBytes(body);
  return {
    manifest: {
      kind: MANIFEST_KIND_CONTAINER,
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: [{ path: 'Dockerfile', digest, size: body.byteLength }],
      egress: { allowedHosts: [], credentials: [] },
      access: 'invited',
      roles: [],
      routes: [],
      secrets,
    },
    digest,
    body,
  };
}

interface OwnerAppOpts {
  email?: string;
  cipherless?: boolean;
  pending?: boolean;
  secretDelivery?: SecretDelivery;
}

async function ownerApp(secrets: string[], opts: OwnerAppOpts = {}): Promise<{
  app: Hono<HonoEnv>;
  session: string;
  appId: string;
  store: Store;
  cipher: EnvelopeSecretCipher;
  goLive: (secrets: string[]) => Promise<void>;
}> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store);
  const cipher = new EnvelopeSecretCipher(new LocalKeyWrapper(Buffer.alloc(32, 9).toString('base64'), 'unit'));
  const s = await newServer({
    harness,
    auth,
    secretCipher: opts.cipherless ? undefined : cipher,
    secretDelivery: opts.secretDelivery,
  });
  const session = await signIn(s.app, opts.email ?? 'boss@firm.com');

  const meRes = await s.app.request('/auth/me', { headers: { Cookie: session } });
  const userId = ((await meRes.json()) as { user: { id: string } }).user.id;
  const svc = harness.platform.for(userId);

  const push = async (names: string[], upload: boolean): Promise<string> => {
    const { manifest, digest, body } = policyManifest(names);
    const res = await svc.sync({ identity: ident(), manifest });
    if (upload && res.missing.length > 0) await svc.putBlob(res.app.id, digest, body.byteLength, bodyOf(body));
    return res.app.id;
  };
  const appId = await push(secrets, !opts.pending);

  return {
    app: s.app,
    session,
    appId,
    store: harness.store,
    cipher,
    goLive: async (names) => {
      await push(names, true);
    },
  };
}

function list(app: Hono<HonoEnv>, session: string, appId: string): Promise<Response> {
  return app.request(`/internal/apps/${appId}/secrets`, { headers: { Cookie: session } });
}

function put(app: Hono<HonoEnv>, session: string, appId: string, body: unknown): Promise<Response> {
  return app.request(`/internal/apps/${appId}/secrets`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function secretAction(
  app: Hono<HonoEnv>,
  session: string,
  appId: string,
  action: 'reveal' | 'delete',
  name: string,
): Promise<Response> {
  return app.request(`/internal/apps/${appId}/secrets/${action}`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('EnvelopeSecretCipher', () => {
  const cipher = new EnvelopeSecretCipher(new LocalKeyWrapper(KEY, 'k1'));

  it('round-trips a value through protect and reveal', async () => {
    const envelope = await cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    expect(await cipher.reveal('app1', 'STRIPE_KEY', envelope)).toBe('sk_live_abc123');
  });

  it('never places the plaintext in the envelope', async () => {
    const secret = 'sbp_secret_9f3c8a21e7b4';
    expect(await cipher.protect('app1', 'SUPABASE_SERVICE_ROLE_KEY', secret)).not.toContain(secret);
  });

  it('binds ciphertext to the app and name via AAD', async () => {
    const envelope = await cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    await expect(cipher.reveal('app2', 'STRIPE_KEY', envelope)).rejects.toThrow();
    await expect(cipher.reveal('app1', 'OTHER_KEY', envelope)).rejects.toThrow();
  });

  it('refuses an envelope sealed under a different master key', async () => {
    const other = new EnvelopeSecretCipher(new LocalKeyWrapper(Buffer.alloc(32, 1).toString('base64'), 'k2'));
    const envelope = await cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    await expect(other.reveal('app1', 'STRIPE_KEY', envelope)).rejects.toThrow(/unavailable key/);
  });

  it('rejects a tampered ciphertext', async () => {
    const parsed = JSON.parse(await cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123'));
    const bytes = Buffer.from(parsed.value.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    parsed.value.ciphertext = bytes.toString('base64');
    await expect(cipher.reveal('app1', 'STRIPE_KEY', JSON.stringify(parsed))).rejects.toThrow();
  });

  it('rejects a tampered wrapped key', async () => {
    const parsed = JSON.parse(await cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123'));
    const bytes = Buffer.from(parsed.wrappedKey, 'base64');
    bytes[bytes.byteLength - 1] ^= 0xff;
    parsed.wrappedKey = bytes.toString('base64');
    await expect(cipher.reveal('app1', 'STRIPE_KEY', JSON.stringify(parsed))).rejects.toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new LocalKeyWrapper(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 byte key/);
  });

  it('routes wrap and unwrap through the KeyWrapper seam', async () => {
    const calls: string[] = [];
    const xor = (data: Buffer) => Buffer.from(data.map((b) => b ^ 0x5a));
    const wrapper: KeyWrapper = {
      keyId: 'fake-kms',
      wrap: (dataKey) => {
        calls.push('wrap');
        return Promise.resolve(xor(dataKey).toString('base64'));
      },
      unwrap: (wrapped) => {
        calls.push('unwrap');
        return Promise.resolve(xor(Buffer.from(wrapped, 'base64')));
      },
    };
    const seamed = new EnvelopeSecretCipher(wrapper);
    const envelope = await seamed.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    expect(JSON.parse(envelope).keyId).toBe('fake-kms');
    expect(await seamed.reveal('app1', 'STRIPE_KEY', envelope)).toBe('sk_live_abc123');
    expect(calls).toEqual(['wrap', 'unwrap']);
  });
});

describe('KmsKeyWrapper', () => {
  const KEY_NAME = 'projects/p/locations/global/keyRings/r/cryptoKeys/k';

  function fakeKms(): { wrapper: KmsKeyWrapper; requests: Array<{ url: string; auth: string; body: Record<string, string> }> } {
    const requests: Array<{ url: string; auth: string; body: Record<string, string> }> = [];
    const xor = (data: Buffer) => Buffer.from(data.map((b) => b ^ 0xa5));
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as Record<string, string>;
      requests.push({ url: String(url), auth: (init!.headers as Record<string, string>).Authorization, body });
      const out = String(url).endsWith(':encrypt')
        ? { ciphertext: xor(Buffer.from(body.plaintext, 'base64')).toString('base64') }
        : { plaintext: xor(Buffer.from(body.ciphertext, 'base64')).toString('base64') };
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch;
    const wrapper = new KmsKeyWrapper(KEY_NAME, '', { fetchImpl, getToken: () => Promise.resolve('tok-1') });
    return { wrapper, requests };
  }

  it('uses the key resource name as keyId and round-trips through encrypt/decrypt', async () => {
    const { wrapper, requests } = fakeKms();
    expect(wrapper.keyId).toBe(KEY_NAME);

    const cipher = new EnvelopeSecretCipher(wrapper);
    const envelope = await cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    expect(JSON.parse(envelope).keyId).toBe(KEY_NAME);
    expect(await cipher.reveal('app1', 'STRIPE_KEY', envelope)).toBe('sk_live_abc123');

    expect(requests.map((r) => r.url)).toEqual([
      `https://cloudkms.googleapis.com/v1/${KEY_NAME}:encrypt`,
      `https://cloudkms.googleapis.com/v1/${KEY_NAME}:decrypt`,
    ]);
    for (const r of requests) {
      expect(r.auth).toBe('Bearer tok-1');
      expect(r.body.additionalAuthenticatedData).toBeTruthy();
    }
    expect(requests[0].body.additionalAuthenticatedData).toBe(requests[1].body.additionalAuthenticatedData);
  });

  it('fails closed on a KMS error status without leaking the response', async () => {
    const fetchImpl = (async () => new Response('{"error":{"message":"denied"}}', { status: 403 })) as typeof fetch;
    const wrapper = new KmsKeyWrapper(KEY_NAME, '', { fetchImpl, getToken: () => Promise.resolve('tok-1') });
    await expect(wrapper.wrap(Buffer.alloc(32), Buffer.from('aad'))).rejects.toThrow(/KMS encrypt failed with status 403/);
  });

  it('rejects malformed credentials JSON before any call', () => {
    expect(() => new KmsKeyWrapper(KEY_NAME, 'not json')).toThrow(/not valid JSON/);
  });
});

describe('secrets list', () => {
  it('reports declared secrets as not configured before any value is set', async () => {
    const { app, session, appId } = await ownerApp(['STRIPE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
    const res = await list(app, session, appId);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { secrets: Array<Record<string, unknown>> };
    expect(data.secrets.map((s) => s.name)).toEqual(['STRIPE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
    for (const s of data.secrets) {
      expect(s.configured).toBe(false);
      expect(s).not.toHaveProperty('value');
      expect(s).not.toHaveProperty('envelope');
    }
  });

  it('lists nothing for an app that declares no secrets', async () => {
    const { app, session, appId } = await ownerApp([]);
    const data = (await (await list(app, session, appId)).json()) as { secrets: unknown[] };
    expect(data.secrets).toEqual([]);
  });
});

describe('secrets write', () => {
  it('stores a value and then reports it configured without ever returning it', async () => {
    const secret = 'sk_live_51H8xExfsdfsdf';
    const { app, session, appId, store, cipher } = await ownerApp(['STRIPE_KEY']);

    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value: secret })).status).toBe(204);

    const res = await list(app, session, appId);
    const raw = await res.text();
    expect(raw).not.toContain(secret);
    const data = (await new Response(raw).json()) as { secrets: Array<Record<string, unknown>> };
    const entry = data.secrets.find((s) => s.name === 'STRIPE_KEY')!;
    expect(entry.configured).toBe(true);
    expect(entry.setBy).toBe('boss@firm.com');
    expect(typeof entry.setAt).toBe('number');
    expect(entry).not.toHaveProperty('value');

    const stored = await store.appSecrets(appId);
    expect(stored).toHaveLength(1);
    expect(stored[0].envelope).not.toContain(secret);
    expect(await cipher.reveal(appId, 'STRIPE_KEY', stored[0].envelope)).toBe(secret);
  });

  it('keeps the plaintext out of the audit log', async () => {
    const secret = 'super-secret-value-42';
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY']);
    await put(app, session, appId, { name: 'STRIPE_KEY', value: secret });

    const events = await store.recentEvents(50);
    const setEvent = events.find((e) => e.kind === 'secret.set');
    expect(setEvent).toBeDefined();
    expect(JSON.stringify(setEvent)).not.toContain(secret);
    expect(setEvent!.detail).toContain('STRIPE_KEY');
  });

  it('overwrites a value on rotation', async () => {
    const { app, session, appId, store, cipher } = await ownerApp(['STRIPE_KEY']);
    await put(app, session, appId, { name: 'STRIPE_KEY', value: 'old-value' });
    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value: 'new-value' })).status).toBe(204);

    const stored = await store.appSecrets(appId);
    expect(stored).toHaveLength(1);
    expect(await cipher.reveal(appId, 'STRIPE_KEY', stored[0].envelope)).toBe('new-value');
  });

  it('rejects a name the manifest never declared', async () => {
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY']);
    expect((await put(app, session, appId, { name: 'GHOST_KEY', value: 'x' })).status).toBe(422);
    expect(await store.appSecrets(appId)).toHaveLength(0);
  });

  it('rejects an empty name or an empty value', async () => {
    const { app, session, appId } = await ownerApp(['STRIPE_KEY']);
    expect((await put(app, session, appId, { name: '', value: 'x' })).status).toBe(422);
    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value: '' })).status).toBe(422);
  });

  it('rejects a non-string name or value instead of coercing it', async () => {
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY']);
    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value: 12345 })).status).toBe(422);
    expect((await put(app, session, appId, { name: ['STRIPE_KEY'], value: 'x' })).status).toBe(422);
    expect(await store.appSecrets(appId)).toHaveLength(0);
  });
});

describe('secrets manage', () => {
  it('reveals a configured value only through the explicit owner action', async () => {
    const { app, session, appId } = await ownerApp(['STRIPE_KEY']);
    await put(app, session, appId, { name: 'STRIPE_KEY', value: 'sk_live_visible' });

    const res = await secretAction(app, session, appId, 'reveal', 'STRIPE_KEY');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ value: 'sk_live_visible' });
  });

  it('deletes a configured value without deleting its declaration', async () => {
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY']);
    await put(app, session, appId, { name: 'STRIPE_KEY', value: 'sk_live_delete' });

    expect((await secretAction(app, session, appId, 'delete', 'STRIPE_KEY')).status).toBe(204);
    expect(await store.appSecrets(appId)).toEqual([]);
    expect(await (await list(app, session, appId)).json()).toEqual({
      secrets: [{ name: 'STRIPE_KEY', configured: false }],
    });
  });

  it('does not reveal values to another signed-in user', async () => {
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY']);
    await put(app, session, appId, { name: 'STRIPE_KEY', value: 'sk_live_private' });
    const intruder = await signIn(app, 'intruder@other.com');

    expect((await secretAction(app, intruder, appId, 'reveal', 'STRIPE_KEY')).status).toBe(404);
    expect((await secretAction(app, intruder, appId, 'delete', 'STRIPE_KEY')).status).toBe(404);
    expect(await store.appSecrets(appId)).toHaveLength(1);
  });
});

describe('live secret delivery', () => {
  it('propagates dashboard sets and deletes without a redeploy', async () => {
    const actions: string[] = [];
    const delivery: SecretDelivery = {
      rollout: async () => {},
      set: async (_app, name) => {
        actions.push(`set:${name}`);
      },
      delete: async (_app, name) => {
        actions.push(`delete:${name}`);
      },
    };
    const { app, session, appId } = await ownerApp(['STRIPE_KEY'], { secretDelivery: delivery });
    const value = ['runtime', 'value'].join(':');

    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value })).status).toBe(204);
    expect((await secretAction(app, session, appId, 'delete', 'STRIPE_KEY')).status).toBe(204);
    expect(actions).toEqual(['delete:STRIPE_KEY']);
  });

  it('fails the request when live delivery fails', async () => {
    const delivery: SecretDelivery = {
      rollout: async () => {},
      set: async () => {
        throw deliveryFailed(['STRIPE_KEY']);
      },
      delete: async () => {},
    };
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY'], { secretDelivery: delivery });
    const value = ['runtime', 'value'].join(':');

    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value })).status).toBe(204);
    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value: value + ':rotated' })).status).toBe(503);
    expect(await store.appSecretNames(appId)).toEqual(['STRIPE_KEY']);
  });
});

describe('secrets before first go-live', () => {
  it('setting the final missing value resumes a parked deploy without another push', async () => {
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY']);
    expect((await store.latestDeploy(appId))?.state).toBe('waiting_secrets');

    const value = ['configured', 'in', 'browser'].join(':');
    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value })).status).toBe(204);

    expect((await store.latestDeploy(appId))?.state).toBe('live');
  });

  it('lists and accepts values for names declared by a pending deploy', async () => {
    const { app, session, appId, store, cipher } = await ownerApp(['STRIPE_KEY'], { pending: true });
    expect(await store.appPolicy(appId)).toBeNull();

    const data = (await (await list(app, session, appId)).json()) as { secrets: Array<Record<string, unknown>> };
    expect(data.secrets.map((s) => s.name)).toEqual(['STRIPE_KEY']);
    expect(data.secrets[0].configured).toBe(false);

    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value: 'sk_live_pre' })).status).toBe(204);
    const stored = await store.appSecrets(appId);
    expect(await cipher.reveal(appId, 'STRIPE_KEY', stored[0].envelope)).toBe('sk_live_pre');
  });
});

describe('secrets lifecycle across deploys', () => {
  it('erases a stored value once the live manifest drops its name, with no resurrection', async () => {
    const { app, session, appId, store, goLive } = await ownerApp(['STRIPE_KEY']);
    await put(app, session, appId, { name: 'STRIPE_KEY', value: 'v1' });

    await goLive([]);
    expect(await store.appSecrets(appId)).toEqual([]);
    const events = await store.recentEvents(50);
    const removed = events.find((e) => e.kind === 'secret.removed');
    expect(removed).toBeDefined();
    expect(removed!.detail).toContain('STRIPE_KEY');
    expect(JSON.stringify(events)).not.toContain('v1');

    await goLive(['STRIPE_KEY']);
    const data = (await (await list(app, session, appId)).json()) as { secrets: Array<Record<string, unknown>> };
    expect(data.secrets).toEqual([{ name: 'STRIPE_KEY', configured: false }]);
  });
});

describe('secrets without an encryption key', () => {
  it('still lists declared names but refuses writes', async () => {
    const { app, session, appId, store } = await ownerApp(['STRIPE_KEY'], { cipherless: true });
    const res = await list(app, session, appId);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { secrets: unknown[] };
    expect(data.secrets).toEqual([{ name: 'STRIPE_KEY', configured: false }]);

    expect((await put(app, session, appId, { name: 'STRIPE_KEY', value: 'x' })).status).toBe(503);
    expect(await store.appSecrets(appId)).toHaveLength(0);
  });
});

describe('secrets authorization', () => {
  it('answers not-found for a signed-in user who does not own the app', async () => {
    const { app, appId, store } = await ownerApp(['STRIPE_KEY']);
    const intruder = await signIn(app, 'mallory@evil.com');
    expect((await list(app, intruder, appId)).status).toBe(404);
    expect((await put(app, intruder, appId, { name: 'STRIPE_KEY', value: 'x' })).status).toBe(404);
    expect(await store.appSecrets(appId)).toHaveLength(0);
  });

  it('refuses an unauthenticated caller on both read and write', async () => {
    const { app, appId } = await ownerApp(['STRIPE_KEY']);
    expect((await app.request(`/internal/apps/${appId}/secrets`)).status).toBe(401);
    const res = await app.request(`/internal/apps/${appId}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'STRIPE_KEY', value: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});
