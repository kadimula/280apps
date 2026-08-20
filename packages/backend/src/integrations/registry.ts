import type { Provider } from './provider.js';

export class UnknownProviderError extends Error {
  constructor(key: string) {
    super(`no integration provider for "${key}"`);
    this.name = 'UnknownProviderError';
  }
}

export class ProviderRegistry {
  private readonly byName = new Map<string, Provider>();
  private readonly byCapability = new Map<string, Provider>();

  constructor(providers: Provider[]) {
    for (const p of providers) {
      this.byName.set(p.name, p);
      for (const cap of p.capabilities) {
        const owner = this.byCapability.get(cap);
        if (owner !== undefined && owner.name !== p.name) {
          throw new Error(`capability "${cap}" is claimed by both "${owner.name}" and "${p.name}"`);
        }
        this.byCapability.set(cap, p);
      }
    }
  }

  get(name: string): Provider {
    const p = this.byName.get(name);
    if (p === undefined) throw new UnknownProviderError(name);
    return p;
  }

  forCapability(capability: string): Provider {
    const p = this.byCapability.get(capability);
    if (p === undefined) throw new UnknownProviderError(capability);
    return p;
  }

  list(): Provider[] {
    return [...this.byName.values()];
  }
}
