// The secrets vault: where the outbound handler reads per-app credentials. The
// values live Worker-side (the Worker's env / a bound secret store) and are
// resolved by NAME at call time; they are never placed in the container's env, so
// the app and its code never see them. The container gets its policy (host + secret
// name) but not the secret value.

export interface Vault {
  // Returns the secret's value, or undefined when it is not provisioned. An
  // unprovisioned credentialed host fails closed at the handler (no fetch).
  get(name: string): string | undefined;
}

// envVault reads secrets from the Worker's env. This is the production vault: the
// owner fills secrets in the 280 UI, the platform binds them as Worker secrets,
// and the container's own env never includes them.
export function envVault(env: unknown): Vault {
  const record = (env ?? {}) as Record<string, unknown>;
  return {
    get(name) {
      const v = record[name];
      return typeof v === 'string' ? v : undefined;
    },
  };
}

// mapVault backs the vault with a plain record, for tests and local doubles.
export function mapVault(secrets: Record<string, string>): Vault {
  return { get: (name) => secrets[name] };
}
