// ControlPlaneConfigDelivery resolves a rollout's config into two channels: plaintext
// `env` (the TWO80_CONFIG var) and `secrets` (Worker secret bindings), split by each
// entry's `sensitive` flag. Two guards the channel rests on: a sensitive value NEVER
// lands in the plaintext env, and a kind='secret' store row is NEVER read (resolve
// reveals only kind='config' rows).

import { describe, expect, it } from 'vitest';
import type { ConfigEntry } from '@280/contracts';
import type { AppSecret, ContainerApp, Store } from '../src/seams.js';
import type { SecretCipher } from '../src/secrets.js';
import { ControlPlaneConfigDelivery } from '../src/config-delivery.js';

const app: ContainerApp = { id: 'app_1', script: 'demo-abc' };

// A cipher whose reveal returns the plaintext verbatim (the envelope IS the value),
// so a leak of a secret value into the config map would be visible in the assertion.
const cipher: SecretCipher = {
  protect: async (_a, _n, v) => v,
  reveal: async (_a, _n, envelope) => envelope,
};

function storeWith(secrets: AppSecret[]): Store {
  return { appSecrets: async () => secrets } as unknown as Store;
}

const secret = (name: string, value: string): AppSecret =>
  ({ appId: app.id, name, envelope: value, setBy: 'owner', setAt: 1, kind: 'secret' });
const configVal = (name: string, value: string): AppSecret =>
  ({ appId: app.id, name, envelope: value, setBy: 'owner', setAt: 1, kind: 'config' });

describe('ControlPlaneConfigDelivery', () => {
  it('routes non-sensitive to env and revealed sensitive to secrets', async () => {
    const store = storeWith([configVal('API_KEY', 'revealed-key')]);
    const delivery = new ControlPlaneConfigDelivery(store, cipher);
    const manifestConfig: ConfigEntry[] = [
      { name: 'REGION', value: 'us-east-1', sensitive: false },
      { name: 'API_KEY', value: '', sensitive: true },
    ];
    expect(await delivery.resolve(app, manifestConfig)).toEqual({
      env: { REGION: 'us-east-1' },
      secrets: { API_KEY: 'revealed-key' },
    });
  });

  it('keeps a committed sensitive value out of the plaintext env', async () => {
    const delivery = new ControlPlaneConfigDelivery(storeWith([]), cipher);
    const resolved = await delivery.resolve(app, [
      { name: 'REGION', value: 'us-east-1', sensitive: false },
      { name: 'STRIPE_KEY', value: 'sk_live_committed', sensitive: true },
    ]);
    expect(resolved).toEqual({
      env: { REGION: 'us-east-1' },
      secrets: { STRIPE_KEY: 'sk_live_committed' },
    });
  });

  it('NEVER reads a kind=secret store row (zero-trust guard)', async () => {
    // The store holds a real secret value under kind='secret'. Even if a config entry
    // shared its name, resolve must not pull the secret-kind row.
    const store = storeWith([
      secret('GOOGLE_SA_JSON', 'super-secret-private-key'),
      configVal('API_KEY', 'entered-key'),
    ]);
    const delivery = new ControlPlaneConfigDelivery(store, cipher);
    const resolved = await delivery.resolve(app, [
      { name: 'API_KEY', value: '', sensitive: true },
      { name: 'REGION', value: 'us-east-1', sensitive: false },
    ]);
    expect(resolved).toEqual({ env: { REGION: 'us-east-1' }, secrets: { API_KEY: 'entered-key' } });
    expect(JSON.stringify(resolved)).not.toContain('super-secret-private-key');
  });

  it('omits a required secret value that has not been entered yet', async () => {
    const delivery = new ControlPlaneConfigDelivery(storeWith([]), cipher);
    const resolved = await delivery.resolve(app, [{ name: 'API_KEY', value: '', sensitive: true }]);
    expect(resolved).toEqual({ env: {}, secrets: {} }); // the waiting gate is what blocks go-live
  });
});
