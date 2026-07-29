// The client half of the device-flow seam. The counterpart to the platform's
// auth endpoints, and the only place the flow's wire paths are written down on
// the client side.
//
// Spec: contracts/auth/authhttp/authhttp.go. Go is normative. Errors use the
// deploy Error shape (thrown as DeployErr) so the CLI has one error shape to
// render; a "not finished yet" answer is authorization_pending, polled on
// rather than failed on (auth.go Pending).

import {
  deviceCodeResponseSchema,
  tokenResponseSchema,
  type DeviceCodeResponse,
} from '../types.js';
import { DeployCode, errorSchema, AuthCode, type DeployError } from '../errors.js';
import { DeployErr, asDeployError } from '../deploy/error.js';
import type { FetchLike } from '../deploy/http.js';

export interface AuthClientOptions {
  fetch?: FetchLike;
}

// Client talks to the auth server. No token: this is how a machine gets one.
export class Client {
  readonly baseURL: string;
  private readonly fetch: FetchLike;

  constructor(baseURL: string, opts: AuthClientOptions = {}) {
    this.baseURL = baseURL;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  }

  // start issues a device code (authhttp.go:31).
  async start(): Promise<DeviceCodeResponse> {
    const out = await this.do('/v1/device/code', undefined);
    return deviceCodeResponseSchema.parse(out);
  }

  // redeem exchanges a device code for a token. It rejects with an
  // authorization_pending DeployErr until the human has approved, which is the
  // expected answer rather than a failure (authhttp.go:42).
  async redeem(deviceCode: string): Promise<string> {
    const out = await this.do('/v1/device/token', { deviceCode });
    return tokenResponseSchema.parse(out).token;
  }

  private async do(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let init: RequestInit;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init = { method: 'POST', headers, body: JSON.stringify(body) };
    } else {
      init = { method: 'POST', headers };
    }
    let resp: Response;
    try {
      resp = await this.fetch(this.baseURL + path, init);
    } catch (err) {
      throw unavailable('call ' + path, err);
    }
    if (Math.floor(resp.status / 100) !== 2) {
      throw await errorFrom(resp);
    }
    try {
      return await resp.json();
    } catch (err) {
      throw unavailable('decode response', err);
    }
  }
}

// New returns a Client for baseURL (authhttp.go:26).
export function newClient(baseURL: string): Client {
  return new Client(baseURL);
}

// pending reports whether err is the flow's "not finished yet" answer, which
// callers poll on rather than fail on (auth.go Pending).
export function pending(err: unknown): boolean {
  const de = asDeployError(err);
  return de !== undefined && de.code === AuthCode.AuthorizationPending;
}

// errorFrom prefers the server's error shape and only synthesizes one when the
// body is something else — a proxy page, an HTML error (authhttp.go:83).
async function errorFrom(resp: Response): Promise<DeployErr> {
  const raw = await readBodyText(resp);
  const parsed = tryParseError(raw);
  if (parsed && parsed.code !== '') {
    return new DeployErr(parsed);
  }
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `unexpected response from 280 (HTTP ${resp.status})`,
    fix: 'run 280 login again',
  });
}

function tryParseError(raw: string): DeployError | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const res = errorSchema.safeParse(obj);
  return res.success ? res.data : undefined;
}

async function readBodyText(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '');
  return text.length > 64 << 10 ? text.slice(0, 64 << 10) : text;
}

function unavailable(what: string, err: unknown): DeployErr {
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `${what}: ${errMessage(err)}`,
    retryable: true,
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
