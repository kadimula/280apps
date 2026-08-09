import { DeployCode, DeployErr } from '@280/contracts';
import type { ContainerApp, SecretDelivery, Store } from './seams.js';
import type { SecretCipher } from './secrets.js';

export interface WorkerSecretStore {
  bulk(app: ContainerApp, values: Record<string, string | null>): Promise<void>;
}

export class ControlPlaneSecretDelivery implements SecretDelivery {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly cipher: SecretCipher | undefined,
    private readonly workers: WorkerSecretStore,
  ) {}

  rollout(app: ContainerApp, declared: string[]): Promise<void> {
    return this.withLock(app.id, async () => {
      const [policy, stored] = await Promise.all([this.store.appPolicy(app.id), this.store.appSecrets(app.id)]);
      const names = new Set([...(policy?.secrets ?? []), ...declared]);
      if (names.size === 0) return;

      const current = new Set(declared);
      const byName = new Map(stored.map((secret) => [secret.name, secret]));
      const values: Record<string, string | null> = {};
      for (const name of names) {
        const secret = current.has(name) ? byName.get(name) : undefined;
        values[name] = secret === undefined ? null : await this.reveal(app.id, secret.name, secret.envelope);
      }
      await this.workers.bulk(app, values);
    });
  }

  set(app: ContainerApp, name: string): Promise<void> {
    return this.withLock(app.id, async () => {
      const policy = await this.store.appPolicy(app.id);
      if (!policy?.secrets.includes(name)) return;
      const secret = (await this.store.appSecrets(app.id)).find((candidate) => candidate.name === name);
      if (secret === undefined) throw deliveryFailed([name]);
      await this.workers.bulk(app, { [name]: await this.reveal(app.id, name, secret.envelope) });
    });
  }

  delete(app: ContainerApp, name: string): Promise<void> {
    return this.withLock(app.id, async () => {
      const policy = await this.store.appPolicy(app.id);
      if (!policy?.secrets.includes(name)) return;
      await this.workers.bulk(app, { [name]: null });
    });
  }

  private async reveal(appId: string, name: string, envelope: string): Promise<string> {
    if (this.cipher === undefined) throw deliveryFailed([name]);
    try {
      return await this.cipher.reveal(appId, name, envelope);
    } catch {
      throw deliveryFailed([name]);
    }
  }

  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(appId) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(appId, tail);
    void tail.then(() => {
      if (this.locks.get(appId) === tail) this.locks.delete(appId);
    });
    return result;
  }
}

export function deliveryFailed(names: string[]): DeployErr {
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `could not deliver app secret${names.length === 1 ? '' : 's'}: ${names.join(', ')}`,
    retryable: true,
  });
}
