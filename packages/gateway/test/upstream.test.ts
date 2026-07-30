import { describe, expect, it } from 'vitest';
import { ContainerUpstream, type AppContainers } from '../src/upstream.js';

// A container binding that runs `handler` as the app's container. `null` script
// names have no container (unreachable).
function containers(handler: (request: Request) => Promise<Response>, has = (_script: string) => true): AppContainers {
  return {
    forScript(script) {
      if (!has(script)) return null;
      return { fetch: (input) => handler(input as Request) } as unknown as Fetcher;
    },
  };
}

const req = (path = '/') =>
  new Request(`https://renewals.280apps.run${path}`, { headers: { 'X-280-Identity': 'signed.token.here' } });

describe('ContainerUpstream', () => {
  it('forwards the identity-stamped request to the container and returns its response', async () => {
    let seen: Request | null = null;
    const up = new ContainerUpstream(
      containers(async (request) => {
        seen = request;
        return new Response('hello from app', { status: 201 });
      }),
    );

    const res = await up.fetch({ request: req('/reports?q=1'), script: 'renewals', identityHeader: 'signed.token.here' });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('hello from app');
    // The container saw the gateway-minted identity header, unchanged.
    expect(seen!.headers.get('X-280-Identity')).toBe('signed.token.here');
    expect(new URL(seen!.url).pathname).toBe('/reports');
  });

  it('answers 502 when no container is bound for the script', async () => {
    const up = new ContainerUpstream(containers(async () => new Response('unused'), () => false));
    const res = await up.fetch({ request: req(), script: 'renewals', identityHeader: 'x' });
    expect(res.status).toBe(502);
  });

  it('surfaces a container that crashed before responding as a 502', async () => {
    const up = new ContainerUpstream(
      containers(async () => {
        throw new Error('container boot failed');
      }),
    );
    const res = await up.fetch({ request: req(), script: 'renewals', identityHeader: 'x' });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('crashed');
  });

  it('answers 404 when the container reports the app is gone', async () => {
    const up = new ContainerUpstream(
      containers(async () => {
        throw new Error('Worker not found');
      }),
    );
    const res = await up.fetch({ request: req(), script: 'renewals', identityHeader: 'x' });
    expect(res.status).toBe(404);
  });
});
