// The runtime capability surface: POST /v1/sdk/integrations/:capability/:operation.
// Mounted under the shared deps middleware, so it reads the request-scoped service off
// the context. It verifies the gateway-signed identity, enforces the body-size bound,
// and returns the service's stable JSON error shape — never a raw provider response.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { ID_HEADER } from '@280/contracts/identity';
import type { HonoEnv } from './../observe.js';
import { SdkError } from './service.js';

const MAX_SDK_BODY = 512 << 10;

export function sdkIntegrationRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post('/:capability/:operation', async (c) => {
    const svc = c.get('deps').integrations;
    if (svc === undefined) return errorJson(c, 'not_configured', 'integrations are not configured', 404);

    const token = bearer(c) || (c.req.header(ID_HEADER) ?? '');
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(c);
    } catch {
      return errorJson(c, 'invalid_request', 'the request body must be a JSON object', 400);
    }

    try {
      const result = await svc.execute({
        token,
        capability: c.req.param('capability') ?? '',
        operation: c.req.param('operation') ?? '',
        body,
      });
      c.header('Cache-Control', 'no-store');
      return c.json(result);
    } catch (err) {
      if (err instanceof SdkError) return errorJson(c, err.code, err.message, err.status, err.retryable);
      return errorJson(c, 'internal_error', 'the request could not be completed', 500);
    }
  });

  return app;
}

function errorJson(c: Context<HonoEnv>, error: string, message: string, status: number, retryable = false): Response {
  c.header('Cache-Control', 'no-store');
  const body: Record<string, unknown> = { error, message };
  if (retryable) body.retryable = true;
  return c.json(body, status as Parameters<typeof c.json>[1]);
}

function bearer(c: Context<HonoEnv>): string {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

async function readJsonBody(c: Context<HonoEnv>): Promise<Record<string, unknown>> {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_SDK_BODY) throw new Error('body too large');
  if (buf.byteLength === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.from(buf).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return parsed as Record<string, unknown>;
}
