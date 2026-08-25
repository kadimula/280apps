import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  DeployCode,
  DeployErr,
  asDeployError,
  statusForCode,
  version,
  type DeployError,
} from '@280/contracts';
import { hashToken } from '../crypto.js';
import type { Service } from '../deploysvc.js';
import { markAccount, type HonoEnv } from '../observe.js';
import type { App as StoreApp, User } from '../seams.js';
import { encodeError } from './encode.js';

export const SMALL_LIMIT = 64 << 10;

const HEADER_CLI_VERSION = 'X-280-Cli-Version';

export type Handler = (c: Context<HonoEnv>) => Promise<Response>;

export function route(fn: Handler): Handler {
  return async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      const de = asDeployError(err);
      if (de !== undefined) return failResponse(de);
      throw err;
    }
  };
}

export function failResponse(de: DeployError): Response {
  return new Response(JSON.stringify(encodeError(de)), {
    status: statusForCode(de.code),
    headers: { 'Content-Type': 'application/json' },
  });
}

export function renderPanic(): Response {
  return failResponse({
    code: DeployCode.Unavailable,
    message: '280 hit an internal error',
    fix: 'run two80 push again, and quote the request id in the response headers',
    retryable: false,
    candidates: [],
  });
}

export async function authorize(c: Context<HonoEnv>): Promise<Service> {
  refuseTooOldCli(c);

  const header = c.req.header('Authorization') ?? '';
  const token = stripBearer(header);
  if (token === '' || token === header.trim()) throw noAccount();

  // An expired token resolves to null like an unknown one, so the CLI's
  // "run two80 login" recovery covers both.
  const minCreatedAt = nowSecs() - c.get('deps').machineTokenTtlSecs;

  let user;
  try {
    user = await c.get('deps').platform.store.userByToken(hashToken(token), minCreatedAt);
  } catch {
    throw new DeployErr({ code: DeployCode.Unavailable, message: 'auth lookup failed', retryable: true });
  }
  if (user === null) throw noAccount();
  markAccount(c, user.id);
  return c.get('deps').platform.for(user.id);
}

function refuseTooOldCli(c: Context<HonoEnv>): void {
  const min = c.get('deps').minCliVersion;
  if (!version.valid(min)) return;
  const got = c.req.header(HEADER_CLI_VERSION) ?? '';
  if (!version.valid(got) || !version.less(got, min)) return;
  throw new DeployErr({
    code: DeployCode.CLITooOld,
    message: `this 280 CLI (${got}) is older than 280 supports (${min})`,
    fix: 'run the same command again; 280 updates itself',
  });
}

function stripBearer(header: string): string {
  const trimmed = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  return trimmed.trim();
}

export async function sessionUser(c: Context<HonoEnv>): Promise<User> {
  const auth = c.get('deps').auth;
  if (auth === undefined) {
    throw new DeployErr({ code: DeployCode.NotFound, message: 'the internal API is not configured' });
  }
  const user = await auth.me(getCookie(c, auth.sessionCookieName) ?? '');
  if (user === null) {
    throw new DeployErr({ code: DeployCode.Unauthorized, message: 'not signed in' });
  }
  return user;
}

// Same not-found answer for a missing app and another user's app: ownership is
// not probeable.
export async function ownedApp(c: Context<HonoEnv>): Promise<{ user: User; app: StoreApp }> {
  const user = await sessionUser(c);
  const appId = c.req.param('app') ?? '';
  let app;
  try {
    app = await c.get('deps').platform.store.app(user.id, appId);
  } catch {
    throw unavailable('could not look up the app');
  }
  if (app !== null) return { user, app };
  throw new DeployErr({ code: DeployCode.NoSuchApp, message: 'that app does not exist on this account' });
}

export function cookieOpts(c: Context<HonoEnv>, maxAge: number): {
  httpOnly: true;
  sameSite: 'Lax';
  path: '/';
  secure: boolean;
  domain?: string;
  maxAge: number;
} {
  const domain = c.get('deps').auth?.cookieDomain ?? '';
  return {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    // Localhost dev over http must not be Secure, or the browser drops the cookie.
    secure: domain !== '' || isSecureRequest(c),
    ...(domain !== '' ? { domain } : {}),
    maxAge,
  };
}

// Trusts the proxy's X-Forwarded-Proto since TLS terminates there.
function isSecureRequest(c: Context<HonoEnv>): boolean {
  if ((c.req.header('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https') return true;
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function readBodyText(c: Context<HonoEnv>, limit: number): Promise<string> {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > limit) throw new Error('request body too large');
  return Buffer.from(buf).toString('utf8');
}

export async function readJson<T>(
  c: Context<HonoEnv>,
  limit: number,
  schema: { parse: (u: unknown) => T },
  onError: { code: string; message: string; fix?: string; appendReason?: boolean },
): Promise<T> {
  try {
    const text = await readBodyText(c, limit);
    return schema.parse(JSON.parse(text));
  } catch (err) {
    const reason =
      onError.appendReason === false ? '' : ': ' + (err instanceof Error ? err.message : String(err));
    throw new DeployErr({ code: onError.code, message: onError.message + reason, fix: onError.fix });
  }
}

export function asObject(u: unknown): Record<string, unknown> {
  if (u === null || typeof u !== 'object' || Array.isArray(u)) throw new Error('expected a JSON object');
  return u as Record<string, unknown>;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function randomSecret(n: number): string {
  return randomBytes(n).toString('hex');
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export function noAccount(): DeployErr {
  return new DeployErr({ code: DeployCode.Unauthorized, message: 'not logged in to 280', fix: 'run two80 login' });
}

export function badRequest(message: string): DeployErr {
  return new DeployErr({ code: DeployCode.PreflightRejected, message });
}

export function unavailable(msg: string): DeployErr {
  return new DeployErr({ code: DeployCode.Unavailable, message: msg, retryable: true });
}
