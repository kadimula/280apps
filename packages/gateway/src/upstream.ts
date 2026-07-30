// The upstream seam: where an authenticated, identity-stamped request goes next —
// the app's running Cloudflare Container. Each app's container is addressed by its
// stable script name (deploysvc assigns it once, never changes); the gateway
// forwards the request it has already stamped with X-280-Identity and streams the
// container's response straight back. No public ingress reaches the container, so
// this proxy hop is the only path in.

export interface Upstream {
  fetch(input: { request: Request; script: string; identityHeader: string }): Promise<Response>;
}

// Resolves an app script to the Fetcher that reaches its running container. In
// production this is a Durable Object namespace of App280Container addressed by
// name; injected so the exact Cloudflare binding stays a deploy concern and the
// proxy stays unit-testable.
export interface AppContainers {
  forScript(script: string): Fetcher | null;
}

export class ContainerUpstream implements Upstream {
  constructor(private readonly containers: AppContainers) {}

  async fetch(input: { request: Request; script: string; identityHeader: string }): Promise<Response> {
    const container = this.containers.forScript(input.script);
    if (container === null) return unreachable();
    try {
      // The request already carries the gateway-minted identity header; forward it
      // as-is so the container sees exactly what the gateway signed.
      return await container.fetch(input.request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A gone container between the access check and here reads as not-found; any
      // other throw is the app failing before it responded — its failure, shown to
      // its visitors, not the platform's.
      if (message.includes('not found') || message.includes('Worker not found')) return appGone();
      return appCrashed();
    }
  }
}

function unreachable(): Response {
  return new Response('This app is not reachable right now. Try again in a moment.\n', {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function appGone(): Response {
  return new Response('This link is wrong, or the app was deleted.\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function appCrashed(): Response {
  return new Response('This app crashed.\n', {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
