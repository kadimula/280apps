// Phase-1 proof Worker: the minimal front for App280Container. It forwards every
// request to the app's container (which listens on defaultPort) and returns the
// response. This is NOT the gateway — no OIDC, no access checks, no identity
// injection; that is phase 2 (packages/gateway), and this stays a thin pipe so
// the proof exercises exactly the container class and its locked defaults.
//
// In production the self-hosted DockerBuilder generates one of these per app (or
// the phase-2 gateway binds the container application by host); here it lets
// `wrangler dev` run a single app end to end.

import { getContainer } from '@cloudflare/containers';

export { App280Container, ContainerProxy } from './container.js';

export default {
  async fetch(request, env) {
    return getContainer(env.APP).fetch(request);
  },
};
