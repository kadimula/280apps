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
// The egress DATA PATH — the credential-injecting outbound handler, the vault read,
// the typed-token minters, the call-log, the fail-closed allowlist wiring — is the
// tested @280/egress package (packages/egress), imported here rather than mirrored.
// The backend image vendors its built dist into this Worker's node_modules.

import { Container } from '@cloudflare/containers';
import { registerEgress as installEgress, applyEgressPolicy } from '@280/egress';

// ContainerProxy must be re-exported from the Worker's main module: the outbound
// interception machinery resolves it via ctx.exports.ContainerProxy.
export { ContainerProxy } from '@cloudflare/containers';
export { applyEgressPolicy };

export class App280Container extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false; // default-deny (NOT the library default, which is true)
  interceptHttps = true; // intercept HTTPS; the buildpack installs the runtime CA
}

// registerEgress installs the package handler on App280Container. The package
// ASSIGNS to the `outboundHandlers` accessor (never a class field): a
// `static outboundHandlers = {...}` class field shadows the base setter and silently
// no-ops (the spike footgun, OQ5). Call once at the front worker's module load.
export function registerEgress() {
  installEgress(App280Container);
}
