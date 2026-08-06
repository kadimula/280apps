// The security contract: no read path, over the API or the audit log, ever returns
// a stored secret value in plaintext.

import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  MANIFEST_KIND_CONTAINER,
  digestBytes,
  type Identity,
  type Manifest,
} from '@280/contracts';
import type { HonoEnv } from '../src/observe.js';
import type { Store } from '../src/seams.js';
import { EnvelopeSecretCipher } from '../src/secrets.js';
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
  const body = bytesOf('FROM scratch\n');
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

async function ownerApp(secrets: string[], email = 'boss@firm.com'): Promise<{
  app: Hono<HonoEnv>;
  session: string;
  appId: string;
  store: Store;
  cipher: EnvelopeSecretCipher;
}> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store);
  const cipher = new EnvelopeSecretCipher(Buffer.alloc(32, 9).toString('base64'), 'unit');
  const s = await newServer({ harness, auth, secretCipher: cipher });
  const session = await signIn(s.app, email);

  const meRes = await s.app.request('/auth/me', { headers: { Cookie: session } });
  const userId = ((await meRes.json()) as { user: { id: string } }).user.id;

  const { manifest, digest, body } = policyManifest(secrets);
  const svc = harness.platform.for(userId);
  const res = await svc.sync({ identity: ident(), manifest });
  if (res.missing.length > 0) await svc.putBlob(res.app.id, digest, body.byteLength, bodyOf(body));

  return { app: s.app, session, appId: res.app.id, store: harness.store, cipher };
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

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('EnvelopeSecretCipher', () => {
  const cipher = new EnvelopeSecretCipher(KEY, 'k1');

  it('round-trips a value through protect and reveal', () => {
    const envelope = cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    expect(cipher.reveal('app1', 'STRIPE_KEY', envelope)).toBe('sk_live_abc123');
  });

  it('never places the plaintext in the envelope', () => {
    const secret = 'sbp_secret_9f3c8a21e7b4';
    expect(cipher.protect('app1', 'SUPABASE_SERVICE_ROLE_KEY', secret)).not.toContain(secret);
  });

  it('binds ciphertext to the app and name via AAD', () => {
    const envelope = cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    expect(() => cipher.reveal('app2', 'STRIPE_KEY', envelope)).toThrow();
    expect(() => cipher.reveal('app1', 'OTHER_KEY', envelope)).toThrow();
  });

  it('refuses an envelope sealed under a different master key', () => {
    const other = new EnvelopeSecretCipher(Buffer.alloc(32, 1).toString('base64'), 'k2');
    const envelope = cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123');
    expect(() => other.reveal('app1', 'STRIPE_KEY', envelope)).toThrow(/unavailable key/);
  });

  it('rejects a tampered ciphertext', () => {
    const parsed = JSON.parse(cipher.protect('app1', 'STRIPE_KEY', 'sk_live_abc123'));
    const bytes = Buffer.from(parsed.value.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    parsed.value.ciphertext = bytes.toString('base64');
    expect(() => cipher.reveal('app1', 'STRIPE_KEY', JSON.stringify(parsed))).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new EnvelopeSecretCipher(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 byte key/);
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
    expect(cipher.reveal(appId, 'STRIPE_KEY', stored[0].envelope)).toBe(secret);
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
    expect(cipher.reveal(appId, 'STRIPE_KEY', stored[0].envelope)).toBe('new-value');
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
