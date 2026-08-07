// Machine-token expiry at the transport layer (api.ts authorize → userByToken):
// a token older than the ttl is refused with the same body an unknown token gets,
// so the CLI's "run two80 login" recovery covers both, while a fresh token still
// authenticates. Runs on the MemoryStore so it controls created_at deterministically
// even when TEST_DATABASE_URL points the shared harness at Postgres.

import { describe, expect, it } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { HttpClient, newPlatform, newServer, seedToken, testManifest } from './helpers/harness.js';

const TTL_SECS = 3600;

describe('machine token expiry (transport)', () => {
  it('rejects an expired token exactly like an unknown one, and accepts a fresh one', async () => {
    const store = new MemoryStore();
    const harness = await newPlatform({ store });
    const now = Math.floor(Date.now() / 1000);

    // A token created before now - ttl is expired; one created now is within it.
    store.tokenClock = () => now - TTL_SECS - 100;
    await seedToken(harness, 'usr_old', 'expired-token');
    store.tokenClock = () => now;
    await seedToken(harness, 'usr_new', 'fresh-token');

    const { app } = await newServer({ harness, machineTokenTtlSecs: TTL_SECS });

    const outcome = async (token: string) => {
      const res = await app.request('/v1/apps/app_x/deploys/dep_x', {
        headers: { Authorization: 'Bearer ' + token },
      });
      return { status: res.status, body: await res.json() };
    };

    const expired = await outcome('expired-token');
    const unknown = await outcome('never-issued-token');
    expect(expired.status).toBe(401);
    expect(expired).toEqual(unknown); // byte-identical: expiry is not distinguishable

    // The fresh token authenticates end to end.
    const sync = await new HttpClient(app, 'fresh-token').sync({
      identity: { slug: 'fresh', framework: 'static' },
      manifest: testManifest().manifest,
    });
    expect(sync.app.id).toBeTruthy();

    await harness.cleanup();
  });
});
