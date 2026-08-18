// The read-side log seam: one app's server logs, resolved to plain LogRecords the
// Service hands back unchanged. The Service owns tenant isolation — it passes a
// script it derived from the owner-checked app, never a client value — so a
// LogSource only ever sees a single script and cannot be asked to span tenants.
//
// The live source is Cloudflare's Workers Observability telemetry query API, which
// (with observability enabled on the app's Worker roll) holds the container's
// stdout/stderr. The seam keeps that coupling in one file: swapping to Logpush or
// the GraphQL analytics API later changes only CloudflareLogSource, not the Service
// or the CLI.

import type { LogRecord } from '@280/contracts';

// LogQueryInput is what the Service asks a source for. `script` is server-derived
// and single-tenant by construction; a source MUST constrain its query to it.
export interface LogQueryInput {
  script: string;
  sinceMs: number; // epoch ms lower bound
  limit: number;
  level: string; // 'error' | 'warn' | 'info' | 'all'
  digest?: string;
}

export interface LogSource {
  query(input: LogQueryInput): Promise<LogRecord[]>;
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const LEVELS = ['error', 'warn', 'info'] as const;

// parseDurationMs reads a look-back window like "15m", "1h", "24h", "7d", "30s".
// A bare number is seconds. Unparseable input falls back to the default so a
// malformed flag never widens the window unexpectedly.
export function parseDurationMs(raw: string, fallbackMs = 60 * 60 * 1000): number {
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/.exec(raw);
  if (m === null) return fallbackMs;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms':
      return n;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return n * 1000; // 's' or bare number
  }
}

export function normalizeLevel(raw: string): string {
  const l = raw.trim().toLowerCase();
  return l === '' ? 'all' : l;
}

// A structured line the platform-injected Next.js onRequestError hook emits, so a
// production digest can be resolved to its real stack. Recognized by t === '280.error'.
interface Two80ErrorLine {
  digest?: string;
  message?: string;
  stack?: string;
  path?: string;
  routerKind?: string;
}

// extract280Error lifts the {digest, stack, path, message} out of a `280.error`
// stderr line. Returns null for any other line, so an ordinary log passes through
// untouched. Tolerant: the payload may be the whole message or embedded in it.
export function extract280Error(message: string): Two80ErrorLine | null {
  const start = message.indexOf('{');
  const end = message.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(message.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.t !== '280.error') return null;
  return {
    digest: str(rec.digest),
    message: str(rec.message),
    stack: str(rec.stack),
    path: str(rec.path),
    routerKind: str(rec.routerKind),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

// CloudflareLogSource queries the Workers Observability telemetry API for exactly
// one script. NOTE (unverified against a live account at build time): the request
// and response shapes below follow Cloudflare's documented telemetry query API; the
// response parser is deliberately tolerant of shape drift, and the whole coupling
// is isolated here behind LogSource. See the PR's verification note.
export class CloudflareLogSource implements LogSource {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(cfg: {
    accountId: string;
    apiToken: string;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.accountId = cfg.accountId;
    this.apiToken = cfg.apiToken;
    this.fetchImpl = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = cfg.now ?? (() => Date.now());
  }

  async query(input: LogQueryInput): Promise<LogRecord[]> {
    const to = this.now();
    const body = this.requestBody(input, to);
    const url = `${CF_API_BASE}/accounts/${this.accountId}/workers/observability/telemetry/query`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(`cloudflare telemetry query failed (HTTP ${res.status})`);
    }
    const events = extractEvents(json);
    const level = normalizeLevel(input.level);
    const out: LogRecord[] = [];
    for (const ev of events) {
      const rec = toLogRecord(ev);
      if (level !== 'all' && rec.level !== level) continue;
      if (input.digest && input.digest !== '' && rec.digest !== input.digest) continue;
      out.push(rec);
    }
    // Newest last so `two80 logs` reads like tail; cap to the requested limit.
    out.sort((a, b) => a.time - b.time);
    return out.length > input.limit ? out.slice(out.length - input.limit) : out;
  }

  // The telemetry query, constrained to this one script. The script filter is the
  // tenant boundary: it is the only service value in the query and comes from the
  // Service's owner-checked app.
  private requestBody(input: LogQueryInput, to: number): Record<string, unknown> {
    const filters: Array<Record<string, unknown>> = [
      { key: '$metadata.service', operation: 'eq', type: 'string', value: input.script },
    ];
    if (input.digest && input.digest !== '') {
      filters.push({ key: 'message', operation: 'includes', type: 'string', value: input.digest });
    }
    return {
      queryId: 'two80-logs',
      timeframe: { from: input.sinceMs, to },
      limit: input.limit,
      view: 'events',
      dry: false,
      parameters: { datasets: ['cloudflare-workers'], filters },
    };
  }
}

// A raw telemetry event, narrowed to the fields the mapper reads. Everything is
// optional because the exact schema is pinned by a live spike, not at build time.
interface RawEvent {
  timestamp?: unknown;
  message?: unknown;
  level?: unknown;
  $metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

// extractEvents reaches the event array wherever the telemetry response nests it,
// tolerating the documented `result.events.events` plus a couple of plausible
// variants so a schema tweak degrades to "no rows", never a throw.
function extractEvents(json: unknown): RawEvent[] {
  if (typeof json !== 'object' || json === null) return [];
  const root = json as Record<string, unknown>;
  const result = (root.result ?? root) as Record<string, unknown>;
  const candidates: unknown[] = [
    (result.events as Record<string, unknown> | undefined)?.events,
    result.events,
    result.rows,
    result.logs,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as RawEvent[];
  }
  return [];
}

function toLogRecord(ev: RawEvent): LogRecord {
  const meta = ev.$metadata ?? {};
  const message = str(ev.message ?? meta.message ?? '');
  const level = mapLevel(str(ev.level ?? meta.level ?? ''));
  const time = toMillis(ev.timestamp ?? meta.timestamp);
  const base: LogRecord = { time, level, message, path: '', digest: '', stack: '' };
  const err = extract280Error(message);
  if (err === null) return base;
  return {
    ...base,
    level: 'error',
    message: err.message || message,
    digest: err.digest ?? '',
    stack: err.stack ?? '',
    path: err.path ?? '',
  };
}

// Cloudflare log levels vary in spelling; fold to the three the CLI filters on.
function mapLevel(raw: string): string {
  const l = raw.toLowerCase();
  if (l === 'error' || l === 'err' || l === 'fatal') return 'error';
  if (l === 'warn' || l === 'warning') return 'warn';
  if (LEVELS.includes(l as (typeof LEVELS)[number])) return l;
  return 'info';
}

function toMillis(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // seconds vs ms heuristic
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(v);
    return Number.isNaN(d) ? 0 : d;
  }
  return 0;
}
