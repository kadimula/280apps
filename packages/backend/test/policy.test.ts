// Phase 4: the access policy travels a real push (SyncRequest → store) and is
// registered when the deploy goes live, the owner's grant is seeded, and a
// malformed policy fails preflight (fail closed) before any state changes.

import { afterEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_KIND_CONTAINER,
  digestBytes,
  type Identity,
  type Manifest,
  type RouteGate,
} from '@280/contracts';
import { EventKind } from '../src/seams.js';
import { bodyOf, bytesOf, newPlatform, type Harness } from './helpers/harness.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

async function harness(): Promise<Harness> {
  const h = await newPlatform();
  live.push(h);
  return h;
}

function route(path: string, gate: Partial<RouteGate>): RouteGate {
  return { path, appRole: gate.appRole ?? '', role: gate.role ?? '' };
}

// A container manifest carrying a policy, plus its single Dockerfile blob.
function policyManifest(over: Partial<Manifest> = {}): { manifest: Manifest; digest: string; body: Uint8Array } {
  const body = bytesOf('FROM scratch\n');
  const digest = digestBytes(body);
  const manifest: Manifest = {
    kind: MANIFEST_KIND_CONTAINER,
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest, size: body.byteLength }],
    egress: { allowedHosts: [], credentials: [] },
    access: 'invited',
    roles: ['manager', 'analyst'],
    routes: [route('/admin/*', { appRole: 'admin' }), route('/api/approve', { role: 'manager' })],
    secrets: ['SUPABASE_URL'],
    ...over,
  };
  return { manifest, digest, body };
}

const ident = (over: Partial<Identity> = {}): Identity => ({
  appId: '',
  slug: 'renewals',
  framework: 'next',
  gitRemote: '',
  clientRef: 'ref1',
  forceNew: false,
  ...over,
});

// Pushes a manifest to a live deploy through the real Service, returning the app id.
async function pushLive(h: Harness, userId: string, m: Manifest, digest: string, body: Uint8Array): Promise<string> {
  const svc = h.platform.for(userId);
  const res = await svc.sync({ identity: ident(), manifest: m });
  for (const name of m.secrets ?? []) {
    await h.store.putAppSecret({ appId: res.app.id, name, envelope: '', setBy: 'owner@test', setAt: 1 });
  }
  if (res.missing.length > 0) await svc.putBlob(res.app.id, digest, body.byteLength, bodyOf(body));
  return res.app.id;
}

describe('manifest policy round-trip', () => {
  it('registers the live deploy policy in the store', async () => {
    const h = await harness();
    const { manifest, digest, body } = policyManifest();

    const appId = await pushLive(h, 'usr_a', manifest, digest, body);
    const policy = await h.store.appPolicy(appId);

    expect(policy).not.toBeNull();
    expect(policy!.access).toBe('invited');
    expect(policy!.roles).toEqual(['manager', 'analyst']);
    expect(policy!.secrets).toEqual(['SUPABASE_URL']);
    expect(policy!.routes).toEqual([
      { path: '/admin/*', appRole: 'admin', role: '' },
      { path: '/api/approve', appRole: '', role: 'manager' },
    ]);
  });

  it('seeds the owner grant and its tenant from the account owner', async () => {
    const h = await harness();
    await h.store.createUser({ id: 'usr_owner', email: 'boss@firm.com', name: 'Boss', image: '' });
    const { manifest, digest, body } = policyManifest({ access: 'anyone-at-tenant' });

    const appId = await pushLive(h, 'usr_owner', manifest, digest, body);

    const owner = await h.store.grant(appId, 'boss@firm.com');
    expect(owner?.appRole).toBe('owner');
    expect((await h.store.appPolicy(appId))!.ownerTenant).toBe('firm.com');
  });

  it('writes a policy.registered audit event', async () => {
    const h = await harness();
    const { manifest, digest, body } = policyManifest();
    const appId = await pushLive(h, 'usr_e', manifest, digest, body);

    const events = await h.store.recentEvents(50);
    const registered = events.find((e) => e.kind === EventKind.PolicyRegistered && e.appId === appId);
    expect(registered).toBeDefined();
  });

  it('re-registers when the policy changes across deploys', async () => {
    const h = await harness();
    const first = policyManifest();
    const appId = await pushLive(h, 'usr_r', first.manifest, first.digest, first.body);
    expect((await h.store.appPolicy(appId))!.access).toBe('invited');

    const second = policyManifest({ access: 'public', routes: [] });
    await pushLive(h, 'usr_r', second.manifest, second.digest, second.body);
    const policy = await h.store.appPolicy(appId);
    expect(policy!.access).toBe('public');
    expect(policy!.routes).toEqual([]);
  });
});

describe('policy preflight (fail closed)', () => {
  async function expectRejected(over: Partial<Manifest>): Promise<void> {
    const h = await harness();
    const { manifest } = policyManifest(over);
    await expect(h.platform.for('usr_x').sync({ identity: ident(), manifest })).rejects.toThrow();
  }

  it('rejects an unknown access mode (the retired link value included)', async () => {
    await expectRejected({ access: 'link' as unknown as Manifest['access'] });
  });

  it('rejects a route that gates on an undeclared feature role', async () => {
    await expectRejected({ roles: ['manager'], routes: [route('/x', { role: 'ghost' })] });
  });

  it('rejects a route with no requirement', async () => {
    await expectRejected({ routes: [route('/x', {})] });
  });

  it('rejects a route with an empty path', async () => {
    await expectRejected({ routes: [route('', { appRole: 'admin' })] });
  });

  it('rejects an unknown app role in a route', async () => {
    await expectRejected({ routes: [route('/x', { appRole: 'superuser' })] });
  });
});

describe('egress preflight (typed + static, fail closed)', () => {
  async function expectEgressRejected(egress: Manifest['egress'], over: Partial<Manifest> = {}): Promise<void> {
    const h = await harness();
    const { manifest } = policyManifest({ egress, ...over });
    await expect(h.platform.for('usr_x').sync({ identity: ident(), manifest })).rejects.toThrow();
  }

  it('accepts a well-formed static credential naming a declared secret', async () => {
    const h = await harness();
    const { manifest, digest, body } = policyManifest({
      secrets: ['STRIPE_KEY'],
      egress: {
        allowedHosts: ['api.stripe.com'],
        credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
      },
    });
    const appId = await pushLive(h, 'usr_ok', manifest, digest, body);
    expect(await h.store.appPolicy(appId)).not.toBeNull();
  });

  // The CLI ships the NORMALIZED wire form: a static credential carries scopes:[] and
  // defaulted header/scheme, a google credential carries header:''/scheme:'' plus
  // scopes. validateEgressPolicy reads field presence and would reject both; the
  // backend runs validateWireEgressPolicy, which restores presence first. Without it,
  // every credentialed push fails enforcement — so these two are the load-bearing
  // reconciliation tests.
  it('accepts the normalized wire form of a static credential', async () => {
    const h = await harness();
    const { manifest, digest, body } = policyManifest({
      secrets: ['STRIPE_KEY'],
      egress: {
        allowedHosts: ['api.stripe.com'],
        credentials: [
          { host: 'api.stripe.com', secret: 'STRIPE_KEY', type: 'header', header: 'authorization', scheme: 'Bearer', scopes: [] },
        ],
      },
    });
    const appId = await pushLive(h, 'usr_ok', manifest, digest, body);
    expect(await h.store.appPolicy(appId)).not.toBeNull();
  });

  it('accepts the normalized wire form of a google-service-account credential', async () => {
    const h = await harness();
    const { manifest, digest, body } = policyManifest({
      secrets: ['GOOGLE_SA'],
      egress: {
        allowedHosts: ['sheets.googleapis.com'],
        credentials: [
          {
            host: 'sheets.googleapis.com',
            secret: 'GOOGLE_SA',
            type: 'google-service-account',
            header: '',
            scheme: '',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          },
        ],
      },
    });
    const appId = await pushLive(h, 'usr_ok', manifest, digest, body);
    expect(await h.store.appPolicy(appId)).not.toBeNull();
  });

  it('accepts the raw authored form of a google-service-account credential', async () => {
    const h = await harness();
    const { manifest, digest, body } = policyManifest({
      secrets: ['GOOGLE_SA'],
      egress: {
        allowedHosts: ['sheets.googleapis.com'],
        credentials: [
          {
            host: 'sheets.googleapis.com',
            secret: 'GOOGLE_SA',
            type: 'google-service-account',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          } as unknown as Manifest['egress']['credentials'][number],
        ],
      },
    });
    const appId = await pushLive(h, 'usr_ok', manifest, digest, body);
    expect(await h.store.appPolicy(appId)).not.toBeNull();
  });

  it('rejects a malformed allowlist host', async () => {
    await expectEgressRejected({ allowedHosts: ['https://api.stripe.com/v1'], credentials: [] });
  });

  it('rejects a malformed credential host', async () => {
    await expectEgressRejected({
      allowedHosts: [],
      credentials: [{ host: 'not a host', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
    });
  });

  it('rejects two credentials for the same host', async () => {
    await expectEgressRejected(
      {
        allowedHosts: [],
        credentials: [
          { host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' },
          { host: 'api.stripe.com', secret: 'OTHER_KEY', header: 'x-api-key', scheme: '' },
        ],
      },
      { secrets: ['STRIPE_KEY', 'OTHER_KEY'] },
    );
  });

  it('rejects an illegal header name', async () => {
    await expectEgressRejected({
      allowedHosts: [],
      credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'bad header', scheme: 'Bearer' }],
    });
  });

  it('rejects a credential with no secret', async () => {
    await expectEgressRejected({
      allowedHosts: [],
      credentials: [{ host: 'api.stripe.com', secret: '', header: 'authorization', scheme: 'Bearer' }],
    });
  });

  it('rejects a credential naming an undeclared secret', async () => {
    await expectEgressRejected(
      {
        allowedHosts: [],
        credentials: [{ host: 'api.stripe.com', secret: 'GHOST_KEY', header: 'authorization', scheme: 'Bearer' }],
      },
      { secrets: ['STRIPE_KEY'] },
    );
  });

  it('rejects a secret whose name collides with a reserved platform binding', async () => {
    await expectEgressRejected(
      {
        allowedHosts: [],
        credentials: [{ host: 'api.stripe.com', secret: 'EGRESS_POLICY', header: 'authorization', scheme: 'Bearer' }],
      },
      { secrets: ['EGRESS_POLICY'] },
    );
  });

  it('rejects an unknown credential type', async () => {
    await expectEgressRejected(
      {
        allowedHosts: [],
        credentials: [
          { host: 'api.stripe.com', secret: 'STRIPE_KEY', type: 'aws-sigv4' } as unknown as Manifest['egress']['credentials'][number],
        ],
      },
      { secrets: ['STRIPE_KEY'] },
    );
  });

  it('rejects a google-service-account credential on a non-provider host', async () => {
    await expectEgressRejected(
      {
        allowedHosts: [],
        credentials: [
          {
            host: 'evil.example.com',
            secret: 'GOOGLE_SA',
            type: 'google-service-account',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          } as unknown as Manifest['egress']['credentials'][number],
        ],
      },
      { secrets: ['GOOGLE_SA'] },
    );
  });

  it('rejects a google-service-account credential on a wildcard host', async () => {
    await expectEgressRejected(
      {
        allowedHosts: [],
        credentials: [
          {
            host: '*.googleapis.com',
            secret: 'GOOGLE_SA',
            type: 'google-service-account',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          } as unknown as Manifest['egress']['credentials'][number],
        ],
      },
      { secrets: ['GOOGLE_SA'] },
    );
  });

  it('rejects a google-service-account credential with no scopes', async () => {
    await expectEgressRejected(
      {
        allowedHosts: [],
        credentials: [
          {
            host: 'sheets.googleapis.com',
            secret: 'GOOGLE_SA',
            type: 'google-service-account',
            scopes: [],
          } as unknown as Manifest['egress']['credentials'][number],
        ],
      },
      { secrets: ['GOOGLE_SA'] },
    );
  });
});
