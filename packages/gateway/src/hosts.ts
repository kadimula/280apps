// Host classification: the auth host, an app host, or reserved/unknown. The gateway
// routes the auth host; app hosts are served by their own Workers.

export const RESERVED = new Set(['www', 'api', 'app', 'admin', 'dashboard', 'status', 'assets', 'auth']);

export const VALID_SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export type HostKind =
  | { kind: 'auth' }
  | { kind: 'app'; script: string; host: string }
  | { kind: 'none' };

export interface HostConfig {
  appDomain: string;
  authHost: string;
  hostSuffix: string;
}

export function classifyHost(hostname: string, cfg: HostConfig): HostKind {
  const host = hostname.toLowerCase();
  if (host === cfg.authHost.toLowerCase()) return { kind: 'auth' };
  if (host !== cfg.appDomain && !host.endsWith('.' + cfg.appDomain)) return { kind: 'none' };
  const script = scriptFor(host, cfg.hostSuffix);
  return script === null ? { kind: 'none' } : { kind: 'app', script, host };
}

// Recovers the app script from a hostname's first label, stripping the dev suffix.
// null for reserved, empty, or malformed labels.
export function scriptFor(hostname: string, hostSuffix: string): string | null {
  let label = hostname.split('.')[0] ?? '';
  if (hostSuffix !== '' && label.length > hostSuffix.length && label.endsWith(hostSuffix)) {
    label = label.slice(0, -hostSuffix.length);
  }
  if (label === '' || RESERVED.has(label) || !VALID_SCRIPT.test(label)) return null;
  return label;
}
