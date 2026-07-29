import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as credentials from '../src/credentials.js';
import { tmpHome } from './helpers.js';

let home: string;
const prev = process.env.TWO80_HOME;

beforeEach(() => {
  home = tmpHome();
  process.env.TWO80_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.TWO80_HOME;
  else process.env.TWO80_HOME = prev;
});

describe('credentials', () => {
  it('load returns loggedIn=false when the file is absent', () => {
    const { loggedIn, creds } = credentials.load();
    expect(loggedIn).toBe(false);
    expect(creds.token).toBe('');
  });

  it('save then load a token', () => {
    credentials.save({ token: 'tok', api: 'https://api.280apps.com' });
    const { loggedIn, creds } = credentials.load();
    expect(loggedIn).toBe(true);
    expect(creds.token).toBe('tok');
    expect(creds.api).toBe('https://api.280apps.com');
  });

  it('omits empty api and pending (mirrors Go omitempty)', () => {
    credentials.save({ token: 'tok' });
    const body = fs.readFileSync(path.join(home, 'credentials'), 'utf8');
    expect(body).toBe('{\n  "token": "tok"\n}\n');
  });

  it('persists a pending login and reads it back', () => {
    const pending: credentials.Pending = {
      deviceCode: 'dev-1',
      userCode: 'ABCD-EFGH',
      url: 'https://api.280apps.com/activate',
      expiresAt: 2_000_000,
      api: 'https://api.280apps.com',
    };
    credentials.save({ token: '', api: 'https://api.280apps.com', pending });
    const { loggedIn, creds } = credentials.load();
    expect(loggedIn).toBe(false);
    expect(creds.pending).toEqual(pending);
  });

  it('writes the credentials file 0600 (POSIX only)', () => {
    credentials.save({ token: 'tok' });
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(home, 'credentials')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  describe('pendingLive', () => {
    const p: credentials.Pending = {
      deviceCode: 'd',
      userCode: 'u',
      url: 'x',
      expiresAt: 100,
      api: 'A',
    };
    it('true when unexpired and api matches', () => {
      expect(credentials.pendingLive(p, 50, 'A')).toBe(true);
    });
    it('false when expired', () => {
      expect(credentials.pendingLive(p, 100, 'A')).toBe(false);
      expect(credentials.pendingLive(p, 200, 'A')).toBe(false);
    });
    it('false when api differs', () => {
      expect(credentials.pendingLive(p, 50, 'B')).toBe(false);
    });
    it('false when undefined or empty device code', () => {
      expect(credentials.pendingLive(undefined, 50, 'A')).toBe(false);
      expect(credentials.pendingLive({ ...p, deviceCode: '' }, 50, 'A')).toBe(false);
    });
  });
});
