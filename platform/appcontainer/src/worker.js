// The per-app harness Worker: the roll config's `main`, one deployed Worker per app on
// its own <script>[-development].280apps.run route. It is now the app's front door.
//
// It compiles in the @280/gateway verify-and-forward middleware (handleAppRequest):
// the middleware reads the host-only 280_id cookie, verifies the short-TTL identity
// token locally against the central gateway's public JWKS (fetched over the GATEWAY
// service binding, cached), mints/refreshes over that binding when needed, enforces the
// baked route gate, stamps X-280-Identity, and hands the request to this app's
// App280Container. The private signing key, DB, and OIDC stay in the central gateway;
// this Worker holds only the public verify path plus the container.
//
// The @280/egress data path is unchanged: the app's 280.json-derived egress policy is
// applied to the container instance (fail-closed allowlist + in-flight credential
// injection) the moment the middleware decides to serve, so an unauthenticated hit
// never spins the container up.

import { getContainer } from '@cloudflare/containers';
import { handleAppRequest } from '@280/gateway/appworker';
import { registerEgress, applyEgressPolicy } from './container.js';

export { App280Container, ContainerProxy } from './container.js';

registerEgress();

function readEgressPolicy(env) {
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
    const container = getContainer(env.APP);
    // Apply the egress boundary lazily, only when the middleware actually serves an
    // authorized request, so unauthenticated visitors do not start the container.
    const guarded = {
      fetch: async (req) => {
        await applyEgressPolicy(container, readEgressPolicy(env), env.TWO80_APP_ID || '');
        return container.fetch(req);
      },
    };
    return handleAppRequest(request, env, { container: guarded });
  },
};
