import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as credentials from '../src/credentials.js';
import { ensureToken, resumeLogin } from '../src/login.js';
import { stubAuth, tmpHome } from './helpers.js';

const API = 'https://api.280apps.com';
const prev = process.env.TWO80_HOME;

beforeEach(() => {
  process.env.TWO80_HOME = tmpHome();
});
afterEach(() => {
  if (prev === undefined) delete process.env.TWO80_HOME;
  else process.env.TWO80_HOME = prev;
});

function savePending(now = 1_000_000): void {
  credentials.save({
    token: '',
    api: API,
    pending: { deviceCode: 'dev-1', userCode: 'ABCD-EFGH', url: API + '/activate', expiresAt: now + 600, api: API },
  });
}

describe('resumeLogin', () => {
  it('returns the token when already logged in', async () => {
    credentials.save({ token: 'tok', api: API });
    const r = await resumeLogin(API, stubAuth({ api: API }), 1_000_000);
    expect(r.token).toBe('tok');
    expect(r.pending).toBeUndefined();
  });

  it('redeems an approved pending login and persists the token, dropping the device code', async () => {
    savePending();
    let redeemed = false;
    const r = await resumeLogin(API, stubAuth({ api: API, token: 'tok-minted', onRedeem: () => (redeemed = true) }), 1_000_000);
    expect(redeemed).toBe(true);
    expect(r.token).toBe('tok-minted');
    const { creds } = credentials.load();
    expect(creds.token).toBe('tok-minted');
    expect(creds.pending).toBeUndefined();
  });

  it('reports pending (not logged in) while the human has not confirmed', async () => {
    savePending();
    const r = await resumeLogin(API, stubAuth({ api: API }), 1_000_000);
    expect(r.token).toBe('');
    expect(r.pending?.userCode).toBe('ABCD-EFGH');
  });

  it('reports nothing in flight for an expired pending code', async () => {
    savePending(0); // expiresAt = 600, well before now
    const r = await resumeLogin(API, stubAuth({ api: API }), 1_000_000);
    expect(r.token).toBe('');
    expect(r.pending).toBeUndefined();
  });

  it('reports logged out with no creds file', async () => {
    const r = await resumeLogin(API, stubAuth({ api: API }), 1_000_000);
    expect(r.token).toBe('');
    expect(r.pending).toBeUndefined();
  });
});

describe('ensureToken', () => {
  it('returns the token when already logged in', async () => {
    credentials.save({ token: 'tok', api: API });
    await expect(ensureToken(API, stubAuth({ api: API }), 1_000_000)).resolves.toBe('tok');
  });

  it('starts a login, persists the pending code, and throws authorization_pending', async () => {
    let started = false;
    await expect(
      ensureToken(API, stubAuth({ api: API, onStart: () => (started = true) }), 1_000_000),
    ).rejects.toMatchObject({ code: 'authorization_pending', fix: expect.stringContaining('/activate') });
    expect(started).toBe(true);
    const { creds } = credentials.load();
    expect(creds.pending?.deviceCode).toBe('dev-code-1');
    expect(creds.pending?.expiresAt).toBe(1_000_000 + 600);
  });

  it('resumes an in-flight login without starting a second one', async () => {
    savePending();
    let started = false;
    await expect(
      ensureToken(API, stubAuth({ api: API, onStart: () => (started = true) }), 1_000_000),
    ).rejects.toMatchObject({ code: 'authorization_pending' });
    expect(started).toBe(false);
  });
});
