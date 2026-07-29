// login authenticates this machine, and never waits for a human.
//
// Agents run commands under timeouts in non-interactive shells, so a command
// that blocks on a browser sign-in is a command that gets killed. Instead the
// flow is split across invocations: one call starts a login and exits with the
// link to show the user, a later call finds the approval waiting and finishes
// silently. The device code lives in ~/.280/credentials between the two.
//
// Both `280 login` and an unauthenticated `280 push` enter through ensureToken,
// so the agent sees the same instruction either way. whoami reports state
// through resumeLogin, which redeems an approval the human just granted rather
// than reporting "not logged in" until some later command happens to redeem it.
// Spec: cli/internal/app/login.go. Go is normative.

import { AuthCode, type DeviceCodeResponse } from '@280/contracts';
import * as credentials from './credentials.js';
import * as output from './output.js';
import { CliError, asError } from './output.js';
import type { Ctx } from './app.js';

export const LOGIN_HELP = `280 login - authenticate this machine; prints a link to show your user, then
re-run to finish. Never waits.

Examples:
  280 login`;

// AuthClient is the device-flow client login drives. The concrete HTTP client
// is W1's auth/http adapter; login depends only on this two-method shape so it
// is fully testable with a double.
export interface AuthClient {
  start(): Promise<DeviceCodeResponse>; // POST /v1/device/code
  redeem(deviceCode: string): Promise<string>; // POST /v1/device/token -> token; throws on pending/expired/denied
}

export interface Resume {
  token: string; // non-empty => logged in
  pending?: credentials.Pending; // set => a login is in flight the human has not confirmed
}

// resumeLogin reports this machine's auth state, finishing a device login the
// human approved since the last command ran. It never starts one.
//
// Exactly one of three outcomes holds: token set (logged in); pending set (a
// login the human has not confirmed); both empty (not logged in, nothing in
// flight). A dead code (expired, claimed, unreachable) reports nothing in
// flight, so a caller that needs a token starts fresh rather than stranding the
// user on it.
export async function resumeLogin(api: string, auth: AuthClient, now: number): Promise<Resume> {
  const { creds, loggedIn } = credentials.load();
  if (loggedIn && creds.api === api) {
    return { token: creds.token };
  }
  if (!credentials.pendingLive(creds.pending, now, api)) {
    return { token: '' };
  }
  const pending = creds.pending!;
  try {
    const token = await auth.redeem(pending.deviceCode);
    credentials.save({ token, api });
    return { token };
  } catch (e) {
    if (asError(e).code === AuthCode.AuthorizationPending) {
      return { token: '', pending };
    }
    return { token: '' };
  }
}

// ensureToken returns a usable API token, starting or resuming a device login if
// there is none. When a human still has to act, it throws the
// authorization_pending error carrying the link to show them.
export async function ensureToken(api: string, auth: AuthClient, now: number): Promise<string> {
  // Resume before starting: the common path is the agent re-running a command
  // after the user signed in, and starting a second login there would
  // invalidate the code they just approved.
  const { token, pending } = await resumeLogin(api, auth, now);
  if (token !== '') return token;
  if (pending) throw waitingOn(pending);

  const start = await auth.start();
  const fresh: credentials.Pending = {
    deviceCode: start.deviceCode,
    userCode: start.userCode,
    url: start.verificationUri,
    expiresAt: now + start.expiresIn,
    api,
  };
  // Persist before throwing: a link the user approves against a code we forgot
  // is the one failure with no recovery except starting over.
  credentials.save({ token: '', api, pending: fresh });
  throw waitingOn(fresh);
}

// cmdLogin authenticates this machine, resuming a login already in flight. When
// a human still has to act, ensureToken throws authorization_pending and the
// dispatcher renders it with the link to relay.
export async function cmdLogin(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;
  const p = output.parseFlags(s, 'login', ctx.args, []);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, LOGIN_HELP);
    return output.ExitOK;
  }
  await ensureToken(ctx.api, ctx.deps.authClient(ctx.api), ctx.deps.now());
  // Self-contained confirmation, no next-step suggestions (AXI §9).
  return output.result(s, { loggedIn: true, api: ctx.api });
}

// waitingOn is the message the agent relays to its user. It is addressed to the
// agent on purpose: the fix tells it what to do with the link and that it must
// not try to open the URL or sign in itself.
export function waitingOn(p: credentials.Pending): CliError {
  return new CliError(
    AuthCode.AuthorizationPending,
    `280 needs your user to sign in: ${p.url} (code ${p.userCode})`,
    `show your user this link and code, wait for them to confirm, then run your command again: ${p.url} (code ${p.userCode})`,
  );
}
