// credentials manages ~/.280/credentials, the account token the CLI sends with
// every API call. It is machine-global (not per-project) and lives outside any
// repo so it is never committed. The token can delete, so the guard on
// destruction is the confirmation `280 delete` demands (the app's own name)
// rather than a scope this file withholds.
// Spec: cli/internal/credentials/credentials.go. Go is normative.

import fs from 'node:fs';
import path from 'node:path';
import * as home from './home.js';

// Pending is an in-flight device login: started but not yet approved. Persisted
// because the flow deliberately does not block: the command that starts a login
// exits, and a later command finishes it.
export interface Pending {
  deviceCode: string; // the CLI's secret, redeemed for a token
  userCode: string; // what the human confirms in the browser
  url: string; // where they confirm it
  expiresAt: number; // unix seconds
  api: string; // endpoint the login was started against
}

// Creds is the stored account token, plus any login still waiting on a human.
export interface Creds {
  token: string;
  api?: string; // endpoint the token was issued for
  pending?: Pending;
}

// pendingLive reports whether p is still worth redeeming at time now (unix
// seconds) against api.
export function pendingLive(p: Pending | undefined, now: number, api: string): boolean {
  return !!p && p.deviceCode !== '' && p.expiresAt > now && p.api === api;
}

// pathOf is ~/.280/credentials, honoring TWO80_HOME for tests.
export function pathOf(): string {
  return home.file('credentials');
}

export interface LoadedCreds {
  creds: Creds;
  loggedIn: boolean;
}

// load reads the token. loggedIn is false (no error) when the user is not
// logged in, the cheap "am I authed" check behind 280 whoami.
export function load(): LoadedCreds {
  let raw: string;
  try {
    raw = fs.readFileSync(pathOf(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { creds: { token: '' }, loggedIn: false };
    }
    throw e;
  }
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

// save writes the token 0600 so other users cannot read it, in a dir 0700.
// Omitting empty api/pending mirrors Go's omitempty so the file is identical.
export function save(c: Creds): void {
  const p = pathOf();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const obj: Record<string, unknown> = { token: c.token };
  if (c.api) obj.api = c.api;
  if (c.pending) obj.pending = c.pending;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
}
