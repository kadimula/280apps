// ControlPlaneConfigDelivery resolves the container-env map for a rollout, and the
// zero-trust guard the whole channel rests on: TWO80_CONFIG (what this returns) may
// NEVER carry a secret's value. A secret is a kind='secret' row the app never reads;
// config is kind='config'. resolve reveals only config-kind rows.

import { describe, expect, it } from 'vitest';
import type { ConfigEntry } from '@280/contracts';
import type { AppSecret, RuntimeApp, Store } from '../src/seams.js';
import type { SecretCipher } from '../src/secrets.js';
import { ControlPlaneConfigDelivery } from '../src/config-delivery.js';

const app: RuntimeApp = { id: 'app_1', slug: 'demo', framework: 'next', script: 'demo-abc', salt: 's', storeId: '' };

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
  it('merges committed-public config with revealed dashboard config', async () => {
    const store = storeWith([configVal('SHEET_ID', 'revealed-id')]);
    const delivery = new ControlPlaneConfigDelivery(store, cipher);
    const manifestConfig: ConfigEntry[] = [
      { name: 'REGION', value: 'us-east-1', sensitive: false },
      { name: 'SHEET_ID', value: '', sensitive: true },
    ];
    expect(await delivery.resolve(app, manifestConfig)).toEqual({ REGION: 'us-east-1', SHEET_ID: 'revealed-id' });
  });

  it('NEVER reveals a secret value into the config map (zero-trust guard)', async () => {
    // The store holds a real secret value under kind='secret'. Even if a config entry
    // shared its name, resolve must not pull the secret-kind row.
    const store = storeWith([
      secret('GOOGLE_SA_JSON', 'super-secret-private-key'),
      configVal('SHEET_ID', 'public-sheet-id'),
    ]);
    const delivery = new ControlPlaneConfigDelivery(store, cipher);
    const map = await delivery.resolve(app, [
      { name: 'SHEET_ID', value: '', sensitive: true },
      { name: 'REGION', value: 'us-east-1', sensitive: false },
    ]);
    expect(map).toEqual({ SHEET_ID: 'public-sheet-id', REGION: 'us-east-1' });
    expect(JSON.stringify(map)).not.toContain('super-secret-private-key');
    expect(map).not.toHaveProperty('GOOGLE_SA_JSON');
  });

  it('omits a required config value that has not been entered yet', async () => {
    const delivery = new ControlPlaneConfigDelivery(storeWith([]), cipher);
    const map = await delivery.resolve(app, [{ name: 'SHEET_ID', value: '', sensitive: true }]);
    expect(map).toEqual({}); // the waiting gate is what blocks go-live; delivery just omits it
  });
});
