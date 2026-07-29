// Observability for API v1: one structured line per request, the request id
// that ties a user's report to that line, and a backstop for handler faults.
//
// Spec: platform/internal/api/observe.go. It sits in front of the router rather
// than inside each handler because the question worth answering — did this call
// succeed, and how long did it take — is the same for every route, and a
// handler that forgets to answer it is silent exactly when it matters.

import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env, RequestDeps } from './config.js';

// RequestIdHeader travels both ways: honored when a caller sends one, minted
// when it does not, and echoed on every response so a bug report can quote a
// value that finds the log line.
export const REQUEST_ID_HEADER = 'X-Request-Id';

// maxRequestId bounds what a caller may put in the log. An id is an opaque
// correlation key, not a place to store a kilobyte.
const MAX_REQUEST_ID = 64;

// Logger is the slog-shaped structured logger the platform writes through. Each
// method emits one record; attrs are flat key/value pairs.
export interface Logger {
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

// HonoEnv carries the Cloudflare bindings (c.env) and the per-request state a
// handler learns that the log line wants but the request itself does not carry.
// deps is the request-scoped I/O container the leading middleware builds; every
// handler reads its Platform and auth from there rather than from the singleton.
export type HonoEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    account: string;
    deps: RequestDeps;
  };
};

// ObserveDeps is what the access log and panic backstop need from the server:
// where to log, and how to render an unmapped fault as the seam's error shape.
export interface ObserveDeps {
  logger: () => Logger;
  // renderPanic turns an unexpected thrown value into the seam's error Response.
  // The DeployErr path is handled by the handlers themselves; anything reaching
  // here is a bug, logged as such.
  renderPanic: (err: unknown) => Response;
}

// observe wraps the router with the access log, request ids, and the panic
// backstop.
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
      // A thrown value that escaped the handlers is a bug: left alone it reaches
      // the CLI as a dropped connection, which is the one failure with no
      // message an agent can act on.
      deps.logger().error('panic in handler', { value: errText(err), stack: stackOf(err) });
      c.res = deps.renderPanic(err);
    }

    // Echo the id on whatever response shipped, minted or honored.
    c.res.headers.set(REQUEST_ID_HEADER, id);

    access(deps.logger(), c, id, took(start));
  };
}

// access writes the line. /healthz is skipped: a container host polls it every
// few seconds forever, and a log that is mostly health checks is one nobody
// reads.
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

// clientIp is the connecting address Cloudflare puts on CF-Connecting-IP: the
// real eyeball, set by the edge and not forgeable by the caller (unlike
// X-Forwarded-For, whose first hop the client controls behind the proxy). Here
// it is only ever a log field; api.ts reads the same header to key the login
// rate limiter, where forgeability would matter.
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

// now is a millisecond clock for request-duration timing. Date.now() is the
// Workers-safe equivalent of the Node process.hrtime it replaces; the frozen-
// clock behavior between I/O points is not chased here — a coarse duration is
// all the access log wants.
function now(): number {
  return Date.now();
}

function took(start: number): number {
  return Math.max(0, now() - start);
}
