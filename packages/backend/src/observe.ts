// Observability for API v1: one structured line per request, the request id that
// ties a user's report to that line, and a backstop for handler faults. It sits in
// front of the router because that question is the same for every route (Go is
// normative: platform/internal/api/observe.go).

import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { RequestDeps } from './config.js';

// Honored when a caller sends one, minted when not, and echoed on every response so
// a bug report can quote a value that finds the log line.
export const REQUEST_ID_HEADER = 'X-Request-Id';

// Bounds what a caller may put in the log: an id is an opaque correlation key.
const MAX_REQUEST_ID = 64;

// Logger is the slog-shaped structured logger the platform writes through; each
// method emits one record with flat key/value attrs.
export interface Logger {
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

// HonoEnv carries the per-request state the log line wants. deps is the I/O
// container the leading middleware builds.
export type HonoEnv = {
  Variables: {
    requestId: string;
    account: string;
    deps: RequestDeps;
  };
};

// ObserveDeps is what the access log and panic backstop need from the server: where
// to log, and how to render an unmapped fault as the seam's error shape.
export interface ObserveDeps {
  logger: () => Logger;
  // Turns an unexpected thrown value into the seam's error Response. Handlers map
  // DeployErr themselves; anything reaching here is a bug.
  renderPanic: (err: unknown) => Response;
}

// observe wraps the router with the access log, request ids, and the panic backstop.
export function observe(deps: ObserveDeps): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const start = now();

    let id = c.req.header(REQUEST_ID_HEADER) ?? '';
    if (id === '' || id.length > MAX_REQUEST_ID) {
      id = newRequestId();
    }
    c.set('requestId', id);

    try {
      await next();
    } catch (err) {
      // A thrown value that escaped the handlers is a bug; left alone it reaches the
      // CLI as a dropped connection, the one failure an agent cannot act on.
      deps.logger().error('panic in handler', { value: errText(err), stack: stackOf(err) });
      c.res = deps.renderPanic(err);
    }

    c.res.headers.set(REQUEST_ID_HEADER, id);

    access(deps.logger(), c, id, took(start));
  };
}

// access writes the line. /healthz is skipped: a host polls it forever, and a log
// mostly of health checks is one nobody reads.
function access(log: Logger, c: Context<HonoEnv>, id: string, ms: number): void {
  if (c.req.path === '/healthz') return;

  const status = c.res.status;
  const attrs: Record<string, unknown> = {
    request: id,
    method: c.req.method,
    path: c.req.path,
    status,
    ms,
    bytes: responseBytes(c.res),
    ip: clientIp(c),
  };
  const account = c.get('account');
  if (account) attrs.account = account;

  // 5xx is ours, 4xx is theirs. Splitting them by level makes "show me what the
  // platform broke" a filter rather than a search.
  if (status >= 500) log.error('request', attrs);
  else if (status >= 400) log.warn('request', attrs);
  else log.info('request', attrs);
}

// markAccount records who the request turned out to be, once authorize knows.
export function markAccount(c: Context<HonoEnv>, accountId: string): void {
  c.set('account', accountId);
}

function responseBytes(res: Response): number {
  const len = res.headers.get('content-length');
  if (len === null) return 0;
  const n = Number(len);
  return Number.isFinite(n) ? n : 0;
}

function newRequestId(): string {
  return randomBytes(8).toString('hex');
}

// clientIp is Cloudflare's CF-Connecting-IP: the real eyeball, set by the edge and
// not forgeable (unlike X-Forwarded-For). Here it is only ever a log field.
export function clientIp(c: Context<HonoEnv>): string {
  return c.req.header('CF-Connecting-IP') ?? '';
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function stackOf(err: unknown): string {
  return err instanceof Error && err.stack ? err.stack : '';
}

// now is a millisecond clock for request-duration timing. Date.now() is Workers-safe;
// a coarse duration is all the access log wants.
function now(): number {
  return Date.now();
}

function took(start: number): number {
  return Math.max(0, now() - start);
}
