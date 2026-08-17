import fs from 'node:fs';
import path from 'node:path';
import * as home from './home.js';
import { readOptional, writeJsonAtomic } from './fsutil.js';
export interface Pending {
  deviceCode: string; // the CLI's secret, redeemed for a token
  userCode: string; // what the human confirms in the browser
  url: string; // where they confirm it
  expiresAt: number; // unix seconds
  api: string; // endpoint the login was started against
}
export interface Creds {
  token: string;
  api?: string; // endpoint the token was issued for
  pending?: Pending;
}
export function pendingLive(p: Pending | undefined, now: number, api: string): boolean {
  return !!p && p.deviceCode !== '' && p.expiresAt > now && p.api === api;
}
function pathOf(): string {
  return home.file('credentials');
}
export interface LoadedCreds {
  creds: Creds;
  loggedIn: boolean;
}
export function load(): LoadedCreds {
  const raw = readOptional(pathOf());
  if (raw === undefined) return { creds: { token: '' }, loggedIn: false };
  const parsed = JSON.parse(raw) as Partial<Creds> & { pending?: Partial<Pending> };
  const creds: Creds = { token: parsed.token ?? '' };
  if (parsed.api) creds.api = parsed.api;
  if (parsed.pending) {
    const p = parsed.pending;
    creds.pending = {
      deviceCode: p.deviceCode ?? '',
      userCode: p.userCode ?? '',
      url: p.url ?? '',
      expiresAt: p.expiresAt ?? 0,
      api: p.api ?? '',
    };
  }
  return { creds, loggedIn: creds.token !== '' };
}
export function save(c: Creds): void {
  const p = pathOf();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const obj: Record<string, unknown> = { token: c.token };
  if (c.api) obj.api = c.api;
  if (c.pending) obj.pending = c.pending;
  writeJsonAtomic(p, obj, 0o600);
}
