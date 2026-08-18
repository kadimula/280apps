import { describe, expect, it } from 'vitest';
import { DeployCode, MANIFEST_KIND_CONTAINER, type Identity, type LogRecord, type Manifest } from '@280/contracts';
import type { LogSource, LogQueryInput } from '../src/logsource.js';
import { HttpClient, newPlatform, newServer, portFor, seedToken, type Harness } from './helpers/harness.js';

class RecordingLogSource implements LogSource {
  readonly calls: LogQueryInput[] = [];
  constructor(private readonly records: LogRecord[] = []) {}
  async query(input: LogQueryInput): Promise<LogRecord[]> {
    this.calls.push(input);
    return this.records;
  }
}

function ident(over: Partial<Identity> = {}): Identity {
  return { appId: '', slug: 'demo', framework: 'static', gitRemote: '', clientRef: 'ref', forceNew: false, ...over };
}

function manifest(): Manifest {
  return {
    kind: MANIFEST_KIND_CONTAINER,
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest: 'a'.repeat(64), size: 10 }],
  } as Manifest;
}

async function seedApp(h: Harness, userId: string): Promise<{ appId: string; script: string }> {
  const port = await portFor(h, userId);
  const res = await port.sync({ identity: ident(), manifest: manifest() });
  const app = await h.store.app(userId, res.app.id);
  return { appId: res.app.id, script: app!.script };
}

const OWNER = 'usr_owner';
const OTHER = 'usr_other';

describe('GET /v1/apps/:app/logs', () => {
  it('returns the owner-resolved app script logs and never caches', async () => {
    const rec: LogRecord = { time: 1_700_000_000_000, level: 'error', message: 'boom', path: '/', digest: 'd1', stack: 'Error: boom' };
    const src = new RecordingLogSource([rec]);
    const h = await newPlatform({ logs: src });
    const { app } = await newServer({ harness: h });
    const { appId, script } = await seedApp(h, OWNER);
    await seedToken(h, OWNER, 'owner-tok');
    const client = new HttpClient(app, 'owner-tok');

    const raw = await client.logsRaw(appId);
    expect(raw.headers.get('Cache-Control')).toBe('no-store');
    const body = (await raw.json()) as { records: Array<Record<string, unknown>> };
    expect(body.records).toEqual([
      { time: rec.time, level: 'error', message: 'boom', path: '/', digest: 'd1', stack: 'Error: boom' },
    ]);
    expect(src.calls).toHaveLength(1);
    expect(src.calls[0]!.script).toBe(script);
    await h.cleanup();
  });

  it('isolates tenants: another account cannot read the app and the source is never queried', async () => {
    const src = new RecordingLogSource([]);
    const h = await newPlatform({ logs: src });
    const { app } = await newServer({ harness: h });
    const { appId } = await seedApp(h, OWNER);
    await seedToken(h, OTHER, 'other-tok');
    const client = new HttpClient(app, 'other-tok');

    await expect(client.logs(appId)).rejects.toMatchObject({ code: DeployCode.NoSuchApp });
    expect(src.calls).toHaveLength(0);
    await h.cleanup();
  });

  it('forwards and clamps the query, and constrains it to the app script', async () => {
    const src = new RecordingLogSource([]);
    const h = await newPlatform({ logs: src });
    const { app } = await newServer({ harness: h });
    const { appId, script } = await seedApp(h, OWNER);
    await seedToken(h, OWNER, 'owner-tok');
    const client = new HttpClient(app, 'owner-tok');

    await client.logs(appId, '?since=24h&limit=99999&level=error&digest=xyz');
    expect(src.calls).toHaveLength(1);
    const q = src.calls[0]!;
    expect(q.script).toBe(script);
    expect(q.limit).toBe(1000);
    expect(q.level).toBe('error');
    expect(q.digest).toBe('xyz');
    const dayMs = 24 * 60 * 60 * 1000;
    expect(Date.now() - q.sinceMs).toBeGreaterThanOrEqual(dayMs - 5000);
    expect(Date.now() - q.sinceMs).toBeLessThanOrEqual(dayMs + 5000);
    await h.cleanup();
  });

  it('answers clearly when no log source is configured', async () => {
    const h = await newPlatform();
    const { app } = await newServer({ harness: h });
    const { appId } = await seedApp(h, OWNER);
    await seedToken(h, OWNER, 'owner-tok');
    const client = new HttpClient(app, 'owner-tok');

    await expect(client.logs(appId)).rejects.toMatchObject({ code: DeployCode.Unavailable });
    await h.cleanup();
  });
});
