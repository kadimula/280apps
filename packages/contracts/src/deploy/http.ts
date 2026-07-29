// The production adapter of Port: it speaks HTTP API v1 to the platform. The
// counterpart to Fake (fake.ts) — both must pass the conformance suite
// (conformance.ts), which is what keeps this honest as the server evolves.
//
// Spec: contracts/deploy/deployhttp/deployhttp.go. Go is normative, including
// the error mapping by status, the retryable coercion of transport errors, and
// the deliberate omission of Content-Length on blob PUT.

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  DeployCode,
  errorSchema,
  type DeployError,
} from '../errors.js';
import {
  deployStatusSchema,
  deleteResultSchema,
  syncResultSchema,
  type Digest,
  type SyncRequest,
  type SyncResult,
  type DeployStatus,
  type DeleteRequest,
  type DeleteResult,
} from '../types.js';
import type { Port, BlobBody } from '../port.js';
import { DeployErr } from './error.js';

// HeaderCLIVersion carries the caller's binary version on every request. The
// server refuses a CLI too old to speak this API (cli_too_old). Empty omits it:
// a local build belongs to whoever built it (deployhttp.go:31).
export const HEADER_CLI_VERSION = 'X-280-Cli-Version';

// FetchLike is the injection seam for the HTTP transport. It matches the global
// fetch, plus the `duplex` init the streamed blob PUT needs.
export type FetchInit = RequestInit & { duplex?: 'half' };
export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

export interface ClientOptions {
  token?: string;
  // cliVersion is sent as HEADER_CLI_VERSION. Empty/undefined omits the header.
  cliVersion?: string;
  // fetch defaults to the global fetch; injectable for tests.
  fetch?: FetchLike;
}

// Client implements Port over HTTP.
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

  // putBlob uploads one content-addressed blob for an open deploy.
  //
  // size is the manifest's declaration and is deliberately NOT forced onto the
  // request as Content-Length. The two can disagree — that is the
  // digest_mismatch case — and forcing the length would surface a local
  // transport error (a retryable "unavailable" and pointless retries) instead
  // of the one non-retryable error that says what went wrong. Streaming the
  // body lets the transport frame it (chunked) rather than assert a length the
  // server did not ask for. The server hashes on receipt and is the only thing
  // entitled to judge the bytes (deployhttp.go:64).
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

  // delete is a POST rather than an HTTP DELETE: the dry run is the common case
  // and destroys nothing, so DELETE would be a lie for most calls
  // (deployhttp.go:104).
  async delete(req: DeleteRequest): Promise<DeleteResult> {
    const out = await this.doJSON('POST', `/v1/apps/${req.appId}/delete`, req);
    return deleteResultSchema.parse(out);
  }

  // headers stamps the two headers every request carries: who is calling
  // (Authorization) and what they are calling with (HEADER_CLI_VERSION).
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

// New returns a Client for baseURL authenticated with token (deployhttp.go:46).
export function newClient(baseURL: string, token: string): Client {
  return new Client(baseURL, { token });
}

// errorFromResponse maps an HTTP failure onto the seam's typed error. The
// server sends the error shape verbatim; a body that is not that shape (a proxy
// error, HTML) is coerced by status class so the agent still gets a fix
// (deployhttp.go:167).
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
        fix: 'run 280 login',
      });
    case 404:
      return new DeployErr({
        code: DeployCode.NotFound,
        message: 'not found',
        fix: 'run 280 push again',
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
        fix: 'run 280 push again; if it persists, check https://280apps.com/status',
      });
  }
}

// tryParseError mirrors Go's json.Unmarshal into deploy.Error: a non-JSON or
// non-error body yields undefined, and the loose schema fills omitempty fields.
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

// readBodyText reads the response body, bounded to 64 KiB like Go's LimitReader.
async function readBodyText(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '');
  return text.length > 64 << 10 ? text.slice(0, 64 << 10) : text;
}

// retryable wraps a transport error as a retryable unavailable, so the caller
// re-runs the loop rather than surfacing a raw network failure
// (deployhttp.go:193).
function retryable(what: string, err: unknown): DeployErr {
  return new DeployErr({
    code: DeployCode.Unavailable,
    message: `${what}: ${errMessage(err)}`,
    retryable: true,
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// toWebStream adapts a BlobBody to the web ReadableStream fetch wants, without
// buffering it: the 100 MiB PUT must stream (plan risk register).
function toWebStream(body: BlobBody): WebReadableStream {
  const readable = body instanceof Readable ? body : Readable.from(body);
  return Readable.toWeb(readable) as unknown as WebReadableStream;
}
