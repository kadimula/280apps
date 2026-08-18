import { describe, expect, it } from 'vitest';
import { CloudflareLogSource, extract280Error, normalizeLevel, parseDurationMs } from '../src/logsource.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NOW = 2_000_000_000_000;

function sourceWith(events: unknown[], capture?: (url: string, body: unknown) => void): CloudflareLogSource {
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    capture?.(String(url), JSON.parse(String(init?.body ?? '{}')));
    return jsonResponse({ success: true, result: { events: { events } } });
  }) as unknown as typeof fetch;
  return new CloudflareLogSource({ accountId: 'acct1', apiToken: 'tok', fetch: fetchImpl, now: () => NOW });
}

describe('parseDurationMs', () => {
  it('parses units and falls back on garbage', () => {
    expect(parseDurationMs('15m')).toBe(15 * 60_000);
    expect(parseDurationMs('2h')).toBe(2 * 3_600_000);
    expect(parseDurationMs('7d')).toBe(7 * 86_400_000);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('45')).toBe(45_000);
    expect(parseDurationMs('nonsense')).toBe(60 * 60_000);
  });
});

describe('extract280Error', () => {
  it('lifts a 280.error payload and ignores anything else', () => {
    const line = JSON.stringify({ t: '280.error', digest: '3004175247', message: 'boom', stack: 'Error: boom\n at x', path: '/', routerKind: 'App Router' });
    expect(extract280Error(line)).toMatchObject({ digest: '3004175247', stack: 'Error: boom\n at x', path: '/' });
    expect(extract280Error('just a normal log line')).toBeNull();
    expect(extract280Error(JSON.stringify({ hello: 'world' }))).toBeNull();
  });
});

describe('CloudflareLogSource.query', () => {
  it('constrains the request to the given script and time window', async () => {
    let seenUrl = '';
    let seenBody: unknown;
    const src = sourceWith([], (url, body) => {
      seenUrl = url;
      seenBody = body;
    });
    await src.query({ script: 'demo-abc', sinceMs: NOW - 3_600_000, limit: 50, level: 'all' });
    expect(seenUrl).toContain('/accounts/acct1/workers/observability/telemetry/query');
    const body = seenBody as { timeframe: { from: number; to: number }; parameters: { filters: Array<Record<string, unknown>> } };
    expect(body.timeframe).toEqual({ from: NOW - 3_600_000, to: NOW });
    const scriptFilter = body.parameters.filters.find((f) => f.key === '$metadata.service');
    expect(scriptFilter).toMatchObject({ operation: 'eq', value: 'demo-abc' });
  });

  it('maps events and lifts a 280.error line to digest+stack', async () => {
    const errLine = JSON.stringify({ t: '280.error', digest: 'd9', message: 'kaboom', stack: 'Error: kaboom', path: '/x', routerKind: 'App Router' });
    const src = sourceWith([
      { timestamp: NOW - 1000, level: 'info', message: 'server started' },
      { timestamp: NOW - 500, level: 'error', message: errLine },
    ]);
    const out = await src.query({ script: 'demo-abc', sinceMs: NOW - 3_600_000, limit: 50, level: 'all' });
    expect(out).toHaveLength(2);
    const err = out.find((r) => r.digest === 'd9')!;
    expect(err.level).toBe('error');
    expect(err.stack).toBe('Error: kaboom');
    expect(err.message).toBe('kaboom');
    expect(err.path).toBe('/x');
  });

  it('filters by level and by digest', async () => {
    const errLine = JSON.stringify({ t: '280.error', digest: 'd9', message: 'kaboom', stack: 'Error: kaboom', path: '/x' });
    const events = [
      { timestamp: NOW - 1000, level: 'info', message: 'noise' },
      { timestamp: NOW - 500, level: 'error', message: errLine },
    ];
    const byLevel = await sourceWith(events).query({ script: 's', sinceMs: 0, limit: 50, level: 'error' });
    expect(byLevel.map((r) => r.level)).toEqual(['error']);

    const byDigest = await sourceWith(events).query({ script: 's', sinceMs: 0, limit: 50, level: 'all', digest: 'd9' });
    expect(byDigest).toHaveLength(1);
    expect(byDigest[0]!.digest).toBe('d9');
  });

  it('throws on a non-2xx telemetry response', async () => {
    const fetchImpl = (async () => jsonResponse({ success: false }, 403)) as unknown as typeof fetch;
    const src = new CloudflareLogSource({ accountId: 'a', apiToken: 't', fetch: fetchImpl, now: () => NOW });
    await expect(src.query({ script: 's', sinceMs: 0, limit: 10, level: 'all' })).rejects.toThrow(/telemetry query failed/);
  });
});

describe('normalizeLevel', () => {
  it('defaults blank to all', () => {
    expect(normalizeLevel('')).toBe('all');
    expect(normalizeLevel(' ERROR ')).toBe('error');
  });
});
