import { describe, expect, it } from 'vitest';
import type { AppPolicy } from '@280/contracts';
import type { AppSecret, ContainerApp, Store } from '../src/seams.js';
import type { SecretCipher } from '../src/secrets.js';
import { ControlPlaneSecretDelivery, type WorkerSecretStore } from '../src/secret-delivery.js';

const app: ContainerApp = {
  id: 'app_1',
  slug: 'demo',
  framework: 'next',
  script: 'demo-abc',
  salt: 'salt',
};

function policy(secrets: string[]): AppPolicy {
  return { access: 'invited', ownerTenant: 'firm.com', roles: [], routes: [], secrets };
}

function setup(currentPolicy: AppPolicy | null, secrets: AppSecret[]) {
  const store = {
    appPolicy: async () => currentPolicy,
    appSecrets: async () => secrets,
  } as unknown as Store;
  const revealed = ['worker', 'credential'].join(':');
  const cipher: SecretCipher = {
    protect: async () => '',
    reveal: async () => revealed,
  };
  const calls: Array<Record<string, string | null>> = [];
  const workers: WorkerSecretStore = {
    bulk: async (_app, values) => {
      calls.push(values);
    },
  };
  return { delivery: new ControlPlaneSecretDelivery(store, cipher, workers), calls, revealed };
}

describe('ControlPlaneSecretDelivery', () => {
  it('decrypts configured secrets and delivers them on rollout', async () => {
    const stored: AppSecret = { appId: app.id, name: 'API_KEY', envelope: 'sealed', setBy: 'owner', setAt: 1 };
    const { delivery, calls, revealed } = setup(null, [stored]);

    await delivery.rollout(app, ['API_KEY']);

    expect(calls).toEqual([{ API_KEY: revealed }]);
  });

  it('does no Worker secret operation when neither deploy declares secrets', async () => {
    const { delivery, calls } = setup(null, []);

    await delivery.rollout(app, []);

    expect(calls).toEqual([]);
  });

  it('deletes values dropped by the next manifest', async () => {
    const stored: AppSecret = { appId: app.id, name: 'OLD_KEY', envelope: 'sealed', setBy: 'owner', setAt: 1 };
    const { delivery, calls } = setup(policy(['OLD_KEY']), [stored]);

    await delivery.rollout(app, []);

    expect(calls).toEqual([{ OLD_KEY: null }]);
  });
});
