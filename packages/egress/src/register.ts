// Registration and per-instance application of the egress policy — the two calls a
// front (the appcontainer worker, or the phase-2 gateway) makes. registerEgress
// installs the named handler on the container class once; applyEgressPolicy binds
// an app's allowlist and per-host credentials onto a specific container instance.

import type { EgressHandlerOptions } from './handler.js';
import { makeEgressHandler } from './handler.js';
import type {
  ContainerStub,
  EgressCallParams,
  EgressContainerClass,
  EgressPolicy,
  OutboundByHostEntry,
} from './types.js';

// The name the single egress handler is registered under in the container class's
// `outboundHandlers` registry. Per-host bindings reference the handler by this name
// (see applyEgressPolicy), so nothing has to serialize a function across the DO
// boundary — only this string plus JSON params.
export const EGRESS_HANDLER_NAME = 'egress';

// registerEgress installs the egress handler on the container class. It ASSIGNS to
// the `outboundHandlers` accessor (never a class field), which is the only
// registration the library honours: a `static outboundHandlers = {...}` class field
// shadows the base setter and silently no-ops (the spike's footgun, OQ5). Call once
// at the front worker's module load.
export function registerEgress(cls: EgressContainerClass, opts: EgressHandlerOptions = {}): void {
  cls.outboundHandlers = { [EGRESS_HANDLER_NAME]: makeEgressHandler(opts) };
}

function paramsFor(policy: EgressPolicy, appId: string, host: string): EgressCallParams {
  const cred = policy.credentials.find((c) => c.host === host);
  return {
    appId,
    host,
    secret: cred?.secret ?? '',
    header: cred?.header || 'authorization',
    scheme: cred?.scheme ?? 'Bearer',
  };
}

// applyEgressPolicy pushes one app's policy onto a running container instance:
//   - setAllowedHosts is the security boundary — anything not listed fails closed
//     with HTTP 520 at the container's own gate (library-enforced, spike-proven).
//   - setOutboundByHosts routes every allowed host through the egress handler, so
//     each allowed call is logged and its credential (if any) is attached.
// Both take only strings / JSON, so this is safe across the Durable Object boundary.
// Idempotent: re-applying the same policy converges on the same interception config.
export async function applyEgressPolicy(
  stub: ContainerStub,
  policy: EgressPolicy,
  appId: string,
): Promise<void> {
  const hosts = policy.allowedHosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
  await stub.setAllowedHosts(hosts);

  const byHost: Record<string, OutboundByHostEntry> = {};
  for (const host of hosts) {
    byHost[host] = { method: EGRESS_HANDLER_NAME, params: paramsFor(policy, appId, host) };
  }
  await stub.setOutboundByHosts(byHost);
}
