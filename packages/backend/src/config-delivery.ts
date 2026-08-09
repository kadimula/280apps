import { publicConfig, type ConfigEntry } from '@280/contracts';
import type { ConfigDelivery, ContainerApp, Store } from './seams.js';
import type { SecretCipher } from './secrets.js';

// ControlPlaneConfigDelivery resolves the container-env map for a rollout: the
// manifest's committed-public values, overlaid with the dashboard-entered values
// (stored encrypted with kind='config') revealed via the cipher. It is the config
// counterpart to ControlPlaneSecretDelivery, but the resolved map is baked into the
// container env (TWO80_CONFIG), never the Worker vault — config is non-secret.
//
// A dashboard value that fails to reveal (missing cipher, bad envelope) is dropped
// rather than thrown: the app sees the committed values, and the missing one is
// caught earlier by the required-config waiting gate, so a reveal fault never wedges
// an otherwise-serviceable roll.
export class ControlPlaneConfigDelivery implements ConfigDelivery {
  constructor(
    private readonly store: Store,
    private readonly cipher: SecretCipher | undefined,
  ) {}

  async resolve(app: ContainerApp, config: ConfigEntry[]): Promise<Record<string, string>> {
    const merged = publicConfig(config);
    const wanted = new Set(config.filter((c) => c.value === '').map((c) => c.name));
    if (wanted.size === 0 || this.cipher === undefined) return merged;

    const stored = await this.store.appSecrets(app.id);
    for (const s of stored) {
      if (s.kind !== 'config' || !wanted.has(s.name)) continue;
      try {
        merged[s.name] = await this.cipher.reveal(app.id, s.name, s.envelope);
      } catch {
        // Left absent; the waiting gate is what guarantees required config is present.
      }
    }
    return merged;
  }
}
