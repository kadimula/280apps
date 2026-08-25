import { Hono } from 'hono';
import type { Context } from 'hono';
import { DeployCode, deleteRequestSchema, syncRequestSchema } from '@280/contracts';
import type { HonoEnv } from '../../observe.js';
import { encodeDeleteResult, encodeLogs, encodeStatus, encodeSyncResult } from '../encode.js';
import { SMALL_LIMIT, authorize, readJson, route } from '../kernel.js';

// Deliberately UNDER Cloudflare's ~100 MB edge limit: a blob at the old 100 MiB cap
// would die at the edge with an HTML 413 the CLI cannot parse.
export const MAX_BLOB_BYTES = 95 << 20;

const SYNC_LIMIT = 8 << 20;

export function deployRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.post('/v1/sync', route(handleSync));
  app.put('/v1/apps/:app/blobs/:digest', route(handlePutBlob));
  app.get('/v1/apps/:app/deploys/:deploy', route(handleStatus));
  app.get('/v1/apps/:app/status', route(handleAppStatus));
  app.get('/v1/apps/:app/logs', route(handleLogs));
  app.post('/v1/apps/:app/delete', route(handleDelete));
  app.get('/v1/whoami', route(handleWhoami));
  return app;
}

async function handleSync(c: Context<HonoEnv>): Promise<Response> {
  const svc = await authorize(c);
  const req = await readJson(c, SYNC_LIMIT, syncRequestSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the sync request',
    fix: 'upgrade the two80 CLI, then run two80 push again',
  });
  const res = await svc.sync(req);
  return c.json(encodeSyncResult(res));
}

async function handlePutBlob(c: Context<HonoEnv>): Promise<Response> {
  const svc = await authorize(c);
  const appId = c.req.param('app') ?? '';
  const digest = c.req.param('digest') ?? '';
  const body = cappedStream(c.req.raw.body, MAX_BLOB_BYTES);
  await svc.putBlob(appId, digest, contentLength(c), body);
  return c.body(null, 204);
}

async function handleStatus(c: Context<HonoEnv>): Promise<Response> {
  const svc = await authorize(c);
  const st = await svc.status(c.req.param('app') ?? '', c.req.param('deploy') ?? '');
  return c.json(encodeStatus(st));
}

async function handleAppStatus(c: Context<HonoEnv>): Promise<Response> {
  const svc = await authorize(c);
  const st = await svc.appStatus(c.req.param('app') ?? '');
  return c.json(encodeStatus(st));
}

async function handleLogs(c: Context<HonoEnv>): Promise<Response> {
  const svc = await authorize(c);
  const q = c.req.query();
  const res = await svc.logs(c.req.param('app') ?? '', {
    since: q.since ?? '1h',
    limit: q.limit !== undefined ? Number(q.limit) : 0,
    level: q.level ?? 'all',
    digest: q.digest ?? '',
    follow: q.follow === '1',
  });
  c.header('Cache-Control', 'no-store');
  return c.json(encodeLogs(res));
}

async function handleDelete(c: Context<HonoEnv>): Promise<Response> {
  const svc = await authorize(c);
  const req = await readJson(c, SMALL_LIMIT, deleteRequestSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the delete request',
    fix: 'upgrade the two80 CLI, then run two80 delete again',
  });
  req.appId = c.req.param('app') ?? '';
  const res = await svc.delete(req);
  return c.json(encodeDeleteResult(res));
}

async function handleWhoami(c: Context<HonoEnv>): Promise<Response> {
  const svc = await authorize(c);
  return c.json(await svc.whoami());
}

function contentLength(c: Context<HonoEnv>): number {
  const len = c.req.header('Content-Length');
  if (len === undefined) return -1;
  const n = Number(len);
  return Number.isFinite(n) ? n : -1;
}

function cappedStream(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): AsyncIterable<Uint8Array> {
  const src = body ?? emptyStream();
  return {
    async *[Symbol.asyncIterator]() {
      let seen = 0;
      const reader = src.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            seen += value.byteLength;
            if (seen > limit) throw new Error(`blob exceeds ${limit} bytes`);
            yield value;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
