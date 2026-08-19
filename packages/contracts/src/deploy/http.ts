// The production adapter of Port, speaking HTTP API v1 to the platform. Like the
// Fake, it must pass the conformance suite, which keeps it honest as the server
// evolves. Spec: contracts/deploy/deployhttp/deployhttp.go (normative).

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DeployCode } from '../errors.js';
import { tryParseError, readBodyText, errMessage } from '../http-body.js';
import {
  deployStatusSchema,
  deleteResultSchema,
  syncResultSchema,
  logsResultSchema,
  whoamiResultSchema,
  type Digest,
  type SyncRequest,
  type SyncResult,
  type DeployStatus,
  type DeleteRequest,
  type DeleteResult,
  type LogQuery,
  type LogsResult,
  type WhoamiResult,
} from '../types.js';
import type { Port, BlobBody } from '../port.js';
import { DeployErr } from './error.js';

// Carries the caller's binary version so the server can refuse a CLI too old to
// speak this API (cli_too_old). Empty omits the header.
export const HEADER_CLI_VERSION = 'X-280-Cli-Version';

// Injection seam for the HTTP transport: the global fetch plus the `duplex` init the streamed blob PUT needs.
export type FetchInit = RequestInit & { duplex?: 'half' };
export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

export interface ClientOptions {
  token?: string;
  // Sent as HEADER_CLI_VERSION; empty/undefined omits the header.
  cliVersion?: string;
  // Defaults to the global fetch; injectable for tests.
  fetch?: FetchLike;
}

export class Client implements Port {
  readonly baseURL: string;
  readonly token: string;
  readonly cliVersion: string;
  private readonly fetch: FetchLike;

  constructor(baseURL: string, opts: ClientOptions = {}) {
    this.baseURL = baseURL;
    this.token = opts.token ?? '';
    this.cliVersion = opts.cliVersion ?? '';
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  }

  async sync(req: SyncRequest): Promise<SyncResult> {
    const out = await this.doJSON('POST', '/v1/sync', req);
    return syncResultSchema.parse(out);
  }

  // size is the manifest's declaration, deliberately NOT sent as Content-Length:
  // the server hashes on receipt and owns the digest_mismatch verdict.
  async putBlob(appId: string, digest: Digest, size: number, body: BlobBody): Promise<void> {
    void size;
    const url = `${this.baseURL}/v1/apps/${appId}/blobs/${digest}`;
    let resp: Response;
    try {
      resp = await this.fetch(url, {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
        body: toWebStream(body) as unknown as RequestInit['body'],
        duplex: 'half',
      });
    } catch (err) {
      throw retryable('upload blob', err);
    }
    if (Math.floor(resp.status / 100) === 2) return;
    throw await errorFromResponse(resp);
  }

  async status(appId: string, deployId: string): Promise<DeployStatus> {
    const out = await this.doJSON('GET', `/v1/apps/${appId}/deploys/${deployId}`, undefined);
    return deployStatusSchema.parse(out);
  }

  async appStatus(appId: string): Promise<DeployStatus> {
    const out = await this.doJSON('GET', `/v1/apps/${appId}/status`, undefined);
    return deployStatusSchema.parse(out);
  }

  // POST, not HTTP DELETE: the dry run is the common case and destroys nothing.
  async delete(req: DeleteRequest): Promise<DeleteResult> {
    const out = await this.doJSON('POST', `/v1/apps/${req.appId}/delete`, req);
    return deleteResultSchema.parse(out);
  }

  async logs(appId: string, query: LogQuery): Promise<LogsResult> {
    const qs = new URLSearchParams();
    qs.set('since', query.since);
    qs.set('limit', String(query.limit));
    qs.set('level', query.level);
    if (query.digest !== '') qs.set('digest', query.digest);
    if (query.follow) qs.set('follow', '1');
    const out = await this.doJSON('GET', `/v1/apps/${appId}/logs?${qs.toString()}`, undefined);
    return logsResultSchema.parse(out);
  }

  async whoami(): Promise<WhoamiResult> {
    const out = await this.doJSON('GET', '/v1/whoami', undefined);
    return whoamiResultSchema.parse(out);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token !== '') h['Authorization'] = 'Bearer ' + this.token;
    if (this.cliVersion !== '') h[HEADER_CLI_VERSION] = this.cliVersion;
    return h;
  }

  private async doJSON(method: string, path: string, body: unknown): Promise<unknown> {
    const headers = this.headers({ Accept: 'application/json' });
    let init: FetchInit;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init = { method, headers, body: JSON.stringify(body) };
    } else {
      init = { method, headers };
    }
    let resp: Response;
    try {
      resp = await this.fetch(this.baseURL + path, init);
    } catch (err) {
      throw retryable('call ' + path, err);
    }
    if (Math.floor(resp.status / 100) !== 2) {
      throw await errorFromResponse(resp);
    }
    try {
      return await resp.json();
    } catch (err) {
      throw retryable('decode response', err);
    }
  }
}

export function newClient(baseURL: string, token: string): Client {
  return new Client(baseURL, { token });
}

// Maps an HTTP failure onto the typed error. The server sends the error shape
// verbatim; a body that is not that shape is coerced by status class so the agent still gets a fix.
async function errorFromResponse(resp: Response): Promise<DeployErr> {
  const raw = await readBodyText(resp);
  const parsed = tryParseError(raw);
  if (parsed && parsed.code !== '') {
    return new DeployErr(parsed);
  }
  switch (resp.status) {
    case 401:
      return new DeployErr({
        code: DeployCode.Unauthorized,
        message: 'not logged in to 280',
        fix: 'run two80 login',
      });
    case 404:
      return new DeployErr({
        code: DeployCode.NotFound,
        message: 'not found',
        fix: 'run two80 push again',
      });
    case 503:
    case 502:
    case 504:
    case 429:
      return new DeployErr({
        code: DeployCode.Unavailable,
        message: '280 is temporarily unavailable',
        retryable: true,
      });
    default:
      return new DeployErr({
        code: DeployCode.Unavailable,
        message: `unexpected response from 280 (HTTP ${resp.status})`,
        fix: 'run two80 push again; if it persists, check https://280apps.com/status',
      });
  }
}

// Wraps a transport error as retryable unavailable, so the caller re-runs the loop.
function retryable(what: string, err: unknown): DeployErr {
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `${what}: ${errMessage(err)}`,
    retryable: true,
  });
}

// Adapts a BlobBody to the web ReadableStream fetch wants without buffering it: the 100 MiB PUT must stream.
function toWebStream(body: BlobBody): WebReadableStream {
  if (body instanceof Readable) return Readable.toWeb(body) as unknown as WebReadableStream;
  if (body instanceof ReadableStream) return body as unknown as WebReadableStream;
  return Readable.toWeb(Readable.from(body)) as unknown as WebReadableStream;
}
