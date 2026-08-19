// GET /v1/whoami resolves the machine token to its account (api.ts resolveUser).
// A bound token returns the account email/name; an unknown token is refused like
// every other token-authenticated route.

import { describe, expect, it } from 'vitest';
import { HttpClient, newPlatform, newServer, seedToken } from './helpers/harness.js';

describe('whoami (transport)', () => {
  it('returns the account behind a bound token, and refuses an unknown one', async () => {
    const harness = await newPlatform();
    await harness.store.createUser({ id: 'usr_1', email: 'ada@example.com', name: 'Ada', image: '' });
    await seedToken(harness, 'usr_1', 'tok-1');

    const { app } = await newServer({ harness });

    const me = await new HttpClient(app, 'tok-1').whoami();
    expect(me).toEqual({ email: 'ada@example.com', name: 'Ada' });

    const denied = await new HttpClient(app, 'never-issued').whoamiRaw();
    expect(denied.status).toBe(401);

    await harness.cleanup();
  });
});
