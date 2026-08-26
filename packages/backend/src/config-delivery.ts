import { publicConfig, type ConfigEntry } from '@280/contracts';
import type { ConfigDelivery, ContainerApp, ResolvedConfig, Store } from './seams.js';
import type { SecretCipher } from './secrets.js';

// ControlPlaneConfigDelivery resolves a rollout's config into two channels, split by
// each entry's `sensitive` flag: non-secret values go to `env` (baked into the
// plaintext TWO80_CONFIG Worker var) and sensitive values go to `secrets` (uploaded
// as write-only Worker secret bindings). Dashboard-entered values (stored encrypted
// with kind='config') are revealed via the cipher and placed in the same way.
//
// A dashboard value that fails to reveal (missing cipher, bad envelope) is dropped
// rather than thrown: the missing one is caught earlier by the required-config
// waiting gate, so a reveal fault never wedges an otherwise-serviceable roll.
export class ControlPlaneConfigDelivery implements ConfigDelivery {
  constructor(
    private readonly store: Store,
    private readonly cipher: SecretCipher | undefined,
  ) {}

  async resolve(app: ContainerApp, config: ConfigEntry[]): Promise<ResolvedConfig> {
    const sensitive = new Set(config.filter((c) => c.sensitive).map((c) => c.name));
    const resolved: ResolvedConfig = { env: {}, secrets: {} };
    const place = (name: string, value: string): void => {
      (sensitive.has(name) ? resolved.secrets : resolved.env)[name] = value;
    };

    for (const [name, value] of Object.entries(publicConfig(config))) place(name, value);

    const wanted = new Set(config.filter((c) => c.value === '').map((c) => c.name));
    if (wanted.size === 0 || this.cipher === undefined) return resolved;

    const stored = await this.store.appSecrets(app.id);
    for (const s of stored) {
      if (s.kind !== 'config' || !wanted.has(s.name)) continue;
      try {
        place(s.name, await this.cipher.reveal(app.id, s.name, s.envelope));
      } catch {
        // Left absent; the waiting gate is what guarantees required config is present.
      }
    }
    return resolved;
  }
}
