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
// package (packages/egress). This harness mirrors that same wiring in ./egress.js
// (kept dependency-free so it is testable in isolation) rather than importing the
// package; keep the two in step (packages/egress/test/exfil.test.ts).

import { Container } from '@cloudflare/containers';
import { EGRESS_HANDLER, egressHandler, applyEgressPolicy } from './egress.js';

// ContainerProxy must be re-exported from the Worker's main module: the outbound
// interception machinery resolves it via ctx.exports.ContainerProxy.
export { ContainerProxy } from '@cloudflare/containers';
export { EGRESS_HANDLER, applyEgressPolicy } from './egress.js';

export class App280Container extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false; // default-deny (NOT the library default, which is true)
  interceptHttps = true; // intercept HTTPS; the buildpack installs the runtime CA
}

// registerEgress installs the handler on the class via the `outboundHandlers`
// accessor (assignment, NOT a class field): a `static outboundHandlers = {...}`
// class field shadows the base setter and silently no-ops (the footgun the spike
// documented, OQ5). Call once at the front worker's module load.
export function registerEgress() {
  App280Container.outboundHandlers = { [EGRESS_HANDLER]: egressHandler };
}
