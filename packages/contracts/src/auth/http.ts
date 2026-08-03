// Client half of the device-flow seam. Spec: contracts/auth/authhttp/authhttp.go
// (normative). Errors use the deploy Error shape; authorization_pending is polled on, not failed on.

import {
  deviceCodeResponseSchema,
  tokenResponseSchema,
  type DeviceCodeResponse,
} from '../types.js';
import { DeployCode } from '../errors.js';
import { DeployErr } from '../deploy/error.js';
import type { FetchLike } from '../deploy/http.js';
import { tryParseError, readBodyText, errMessage } from '../http-body.js';

export interface AuthClientOptions {
  fetch?: FetchLike;
}

// No token: this is how a machine gets one.
export class Client {
  readonly baseURL: string;
  private readonly fetch: FetchLike;

  constructor(baseURL: string, opts: AuthClientOptions = {}) {
    this.baseURL = baseURL;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  }

  async start(): Promise<DeviceCodeResponse> {
    const out = await this.do('/v1/device/code', undefined);
    return deviceCodeResponseSchema.parse(out);
  }

  // Rejects authorization_pending until the human approves: the expected answer, not a failure.
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

export function newClient(baseURL: string): Client {
  return new Client(baseURL);
}

// Prefers the server's error shape, synthesizing one only for a non-error body (proxy page, HTML).
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

function unavailable(what: string, err: unknown): DeployErr {
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `${what}: ${errMessage(err)}`,
    retryable: true,
  });
}
