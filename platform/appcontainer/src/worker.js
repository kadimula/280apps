// Phase-1 proof Worker: the minimal front for App280Container. It applies the app's
// egress policy to the container instance, then forwards every request to the app
// (which listens on defaultPort) and returns the response. This is NOT the gateway
// — no OIDC, no access checks, no identity injection; that is phase 2
// (packages/gateway), which will import @280/egress and apply the same policy.
//
// The policy comes from EGRESS_POLICY (JSON) in the Worker env, which the platform
// derives from the app's 280.json at deploy. Absent/empty => default-deny (the
// container reaches nothing). In production the DockerBuilder generates the per-app
// image and the gateway binds it by host; here this lets `wrangler dev` run one app
// end to end with its egress boundary enforced.

import { getContainer } from '@cloudflare/containers';
import { registerEgress, applyEgressPolicy } from './container.js';

export { App280Container, ContainerProxy } from './container.js';

registerEgress();

function readPolicy(env) {
  if (!env || typeof env.EGRESS_POLICY !== 'string' || env.EGRESS_POLICY === '') {
    return { allowedHosts: [], credentials: [] };
  }
  try {
    const p = JSON.parse(env.EGRESS_POLICY);
    return { allowedHosts: p.allowedHosts || [], credentials: p.credentials || [] };
  } catch {
    return { allowedHosts: [], credentials: [] }; // malformed => fail safe (default-deny)
  }
}

export default {
  async fetch(request, env) {
    const stub = getContainer(env.APP);
    await applyEgressPolicy(stub, readPolicy(env), env.APP_ID || '');
    return stub.fetch(request);
  },
};
