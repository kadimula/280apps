// The scheduled cleanup sweep (worker.ts scheduled() → sweepExpired): deletes
// expired sessions, device codes, and lapsed login-rate windows, leaves valid
// rows, and logs the per-table counts. The store double stands in for the real
// Postgres, which implements the same deleteExpired seam.

import { describe, expect, it } from 'vitest';
import { sweepExpired } from '../src/deps.js';
import { DeviceStatus } from '../src/seams.js';
import { MemoryStore } from './helpers/memory-store.js';
import { capturingLogger } from './helpers/harness.js';

describe('scheduled cleanup', () => {
  it('removes expired rows, keeps fresh ones, and logs the counts', async () => {
    const store = new MemoryStore();
    const now = 1_000_000;

    await store.createSession({ tokenHash: 'sess_old', userId: 'u1', expiresAt: now - 1 });
    await store.createSession({ tokenHash: 'sess_new', userId: 'u2', expiresAt: now + 3600 });

    await store.createDeviceCode({
      deviceHash: 'dc_old',
      userCode: 'AAAA1111',
      accountId: '',
      status: DeviceStatus.Pending,
      expiresAt: now - 1,
    });
    await store.createDeviceCode({
      deviceHash: 'dc_new',
      userCode: 'BBBB2222',
      accountId: '',
      status: DeviceStatus.Pending,
      expiresAt: now + 3600,
    });

    // touchLoginRate stores expires_at = start + window: the first window lapsed
    // one second before now, the second is current.
    await store.touchLoginRate('ip_old', now - 1000, 1, 100);
    await store.touchLoginRate('ip_new', now, 600, 100);

    const { logger, records } = capturingLogger();
    const counts = await sweepExpired(store, logger, now);

    expect(counts).toEqual({ sessions: 1, deviceCodes: 1, rateLimits: 1 });

    expect(await store.sessionByHash('sess_new')).not.toBeNull();
    expect(await store.sessionByHash('sess_old')).toBeNull();
    expect(await store.deviceCodeByHash('dc_new')).not.toBeNull();
    expect(await store.deviceCodeByHash('dc_old')).toBeNull();

    const line = records.find((r) => r.msg === 'scheduled cleanup');
    expect(line?.attrs).toMatchObject({ sessions: 1, deviceCodes: 1, rateLimits: 1 });
  });

  it('is an idempotent no-op when nothing has expired', async () => {
    const store = new MemoryStore();
    const now = 1_000_000;
    await store.createSession({ tokenHash: 's', userId: 'u', expiresAt: now + 10 });

    const { logger } = capturingLogger();
    expect(await sweepExpired(store, logger, now)).toEqual({ sessions: 0, deviceCodes: 0, rateLimits: 0 });
    expect(await store.sessionByHash('s')).not.toBeNull();
  });
});
