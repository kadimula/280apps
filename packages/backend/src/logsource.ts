import type { LogRecord } from '@280/contracts';

export interface LogQueryInput {
  script: string;
  sinceMs: number;
  limit: number;
  level: string;
  digest?: string;
}

export interface LogSource {
  query(input: LogQueryInput): Promise<LogRecord[]>;
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const LEVELS = ['error', 'warn', 'info'] as const;

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
      return n * 1000;
  }
}

export function normalizeLevel(raw: string): string {
  const l = raw.trim().toLowerCase();
  return l === '' ? 'all' : l;
}

interface Two80ErrorLine {
  digest?: string;
  message?: string;
  stack?: string;
  path?: string;
  routerKind?: string;
}

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
    out.sort((a, b) => a.time - b.time);
    return out.length > input.limit ? out.slice(out.length - input.limit) : out;
  }

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

interface RawEvent {
  timestamp?: unknown;
  message?: unknown;
  level?: unknown;
  $metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

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

function mapLevel(raw: string): string {
  const l = raw.toLowerCase();
  if (l === 'error' || l === 'err' || l === 'fatal') return 'error';
  if (l === 'warn' || l === 'warning') return 'warn';
  if (LEVELS.includes(l as (typeof LEVELS)[number])) return l;
  return 'info';
}

function toMillis(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(v);
    return Number.isNaN(d) ? 0 : d;
  }
  return 0;
}
