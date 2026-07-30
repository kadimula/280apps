// The upstream seam: where an authenticated, identity-stamped request goes next.
// SEAM (container phase): the real target is the app container (design §04) or,
// on the WfP substrate, the dispatch-namespace binding. This slice ships a stub.

export interface Upstream {
  fetch(input: { request: Request; script: string; identityHeader: string }): Promise<Response>;
}

// Echoes what it received (including the identity header) so an end-to-end test
// can prove a valid signed identity arrived.
export class StubUpstream implements Upstream {
  async fetch(input: { request: Request; script: string; identityHeader: string }): Promise<Response> {
    const url = new URL(input.request.url);
    const body = {
      upstream: 'stub',
      script: input.script,
      method: input.request.method,
      path: url.pathname + url.search,
      identity: input.identityHeader,
    };
    return new Response(JSON.stringify(body, null, 2) + '\n', {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-280-identity-seen': input.identityHeader,
      },
    });
  }
}
