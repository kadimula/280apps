// App280Container: the container class every 280 app runs in, with the platform
// security defaults locked on (confirmed on real Cloudflare Containers). These are
// class-level, never the app's to set:
//
//   enableInternet = false  Default-deny egress. The @cloudflare/containers base
//                           class defaults this to TRUE, so leaving it unset would
//                           silently give every app open outbound internet. 280
//                           forces it off; unlisted hosts fail closed with 520.
//   interceptHttps = true   Outbound HTTPS is intercepted so the platform attaches
//                           credentials the container never sees. This needs the
//                           container to trust Cloudflare's runtime CA, which the
//                           buildpack's entrypoint installs.
//   defaultPort = 8080      The port the buildpack makes every app listen on and
//                           the gateway routes to; the two must agree.
//
// The egress DATA PATH — the credential-injecting outbound handler, the vault
// read, the call-log, the fail-closed allowlist wiring — is the tested @280/egress
// package (packages/egress). This harness mirrors that same wiring inline rather
// than importing it; keep the two in step (packages/egress/test/exfil.test.ts).

import { Container } from '@cloudflare/containers';

// ContainerProxy must be re-exported from the Worker's main module: the outbound
// interception machinery resolves it via ctx.exports.ContainerProxy.
export { ContainerProxy } from '@cloudflare/containers';

export class App280Container extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false; // default-deny (NOT the library default, which is true)
  interceptHttps = true; // intercept HTTPS; the buildpack installs the runtime CA
}

// The single named handler every allowlisted host is routed through. Registering a
// NAMED handler (not a per-host function map) is what lets the front bind hosts at
// runtime via setOutboundByHost(host, EGRESS_HANDLER, params) — only strings and
// JSON cross the Durable Object boundary, so the secret's NAME travels while its
// VALUE stays Worker-side. Mirrors @280/egress EGRESS_HANDLER_NAME.
export const EGRESS_HANDLER = 'egress';

// The outbound handler runs in the Workers runtime, outside the container sandbox.
// `env` is the Worker env (the vault); it reads the secret by name and attaches it
// in-flight, so the container's image/env/code never hold the credential. Every
// call is logged (destination + whether a credential was attached, never its value).
function egressHandler(req, env, ctx) {
  const p = ctx.params || {};
  const url = new URL(req.url);
  const host = p.host || url.hostname;
  const event = { appId: p.appId || '', host, method: req.method, path: url.pathname, at: Date.now() };

  if (p.secret) {
    const value = env && typeof env[p.secret] === 'string' ? env[p.secret] : undefined;
    if (!value) {
      // Fail closed: a credentialed host with no provisioned secret is not forwarded.
      console.log('[280-egress] ' + JSON.stringify({ ...event, status: 0, credentialAttached: false, secret: p.secret, outcome: 'denied', reason: 'missing-secret' }));
      return new Response('Origin is disallowed', { status: 520 });
    }
    const headers = new Headers(req.headers);
    headers.set(p.header || 'authorization', p.scheme ? `${p.scheme} ${value}` : value);
    return fetch(new Request(req, { headers })).then((res) => {
      console.log('[280-egress] ' + JSON.stringify({ ...event, status: res.status, credentialAttached: true, secret: p.secret, outcome: 'forwarded' }));
      return res;
    });
  }
  return fetch(req).then((res) => {
    console.log('[280-egress] ' + JSON.stringify({ ...event, status: res.status, credentialAttached: false, secret: '', outcome: 'forwarded' }));
    return res;
  });
}

// registerEgress installs the handler on the class via the `outboundHandlers`
// accessor (assignment, NOT a class field): a `static outboundHandlers = {...}`
// class field shadows the base setter and silently no-ops (the footgun the spike
// documented, OQ5). Call once at the front worker's module load.
export function registerEgress() {
  App280Container.outboundHandlers = { [EGRESS_HANDLER]: egressHandler };
}

// applyEgressPolicy pushes one app's 280.json-derived policy onto a running
// instance: setAllowedHosts is the fail-closed security boundary (anything not
// listed → 520 at the container gate), and every allowed host is routed through the
// egress handler so each call is logged and its credential (if any) attached.
export async function applyEgressPolicy(stub, policy, appId) {
  const hosts = (policy?.allowedHosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  await stub.setAllowedHosts(hosts);
  const byHost = {};
  for (const host of hosts) {
    const cred = (policy.credentials || []).find((c) => c.host === host);
    byHost[host] = {
      method: EGRESS_HANDLER,
      params: {
        appId: appId || '',
        host,
        secret: cred?.secret || '',
        header: cred?.header || 'authorization',
        scheme: cred?.scheme ?? 'Bearer',
      },
    };
  }
  await stub.setOutboundByHosts(byHost);
}
