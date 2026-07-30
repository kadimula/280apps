// App280Container: the container class every 280 app runs in, with the platform
// security defaults locked on (spike-confirmed on real Cloudflare Containers, see
// _spike/280-p0-egress-spike). These are class-level, never the app's to set:
//
//   enableInternet = false  Default-deny egress. The @cloudflare/containers base
//                           class defaults this to TRUE, so leaving it unset would
//                           silently give every app open outbound internet. 280
//                           forces it off; unlisted hosts fail closed with 520.
//   interceptHttps = true   Outbound HTTPS is intercepted so the platform can (in
//                           phase 3) attach credentials the container never sees.
//                           This needs the container to trust Cloudflare's runtime
//                           CA, which the buildpack's entrypoint installs.
//   defaultPort = 8080      The port the buildpack makes every app listen on and
//                           the gateway routes to; the two must agree.
//
// Per-app egress policy (allow/deny lists, credentialed outbound handlers) is
// phase 3; registerEgress below is the ONLY supported way to attach it, because a
// `static outboundByHost = {...}` class field silently no-ops (JS define-semantics
// shadow the base accessor — the footgun the spike documented). Nothing here opens
// egress; a hello-world app needs none.

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

// registerEgress attaches per-host outbound handlers via the base-class accessor
// (assignment, not a class field), so the registration actually runs instead of
// silently shadowing it. This is the encapsulation that keeps app authors from
// tripping the class-field footgun. Phase 3 calls this with the app's allowlist
// and credentialed handlers; phase 1 does not call it at all.
export function registerEgress(handlersByHost) {
  App280Container.outboundByHost = handlersByHost;
}
