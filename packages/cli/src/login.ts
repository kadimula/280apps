// login authenticates this machine and never waits for a human. Agents run under
// timeouts in non-interactive shells, so a blocking browser sign-in gets killed.
// The flow is split across invocations: one call starts a login and exits with the
// link, a later call finds the approval and finishes. The device code lives in
// ~/.280/credentials between the two.
// Spec: cli/internal/app/login.go; Go is normative.

import { AuthCode, type DeviceCodeResponse } from '@280/contracts';
import * as credentials from './credentials.js';
import * as output from './output.js';
import { CliError, asError } from './output.js';
import type { Ctx } from './app.js';

const LOGIN_HELP = `two80 login - authenticate this machine; prints a link to show your user, then
re-run to finish. Never waits.

Examples:
  two80 login`;

// AuthClient is the device-flow client login drives. login depends only on this
// two-method shape so it is fully testable with a double.
export interface AuthClient {
  start(): Promise<DeviceCodeResponse>; // POST /v1/device/code
  redeem(deviceCode: string): Promise<string>; // POST /v1/device/token -> token; throws on pending/expired/denied
}

export interface Resume {
  token: string; // non-empty => logged in
  pending?: credentials.Pending; // set => a login is in flight the human has not confirmed
}

// resumeLogin reports this machine's auth state, finishing a device login the
// human approved since the last command ran. It never starts one. Exactly one
// holds: token set (logged in), pending set (unconfirmed), or both empty (nothing
// in flight). A dead code reports nothing in flight so a caller starts fresh.
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
// there is none. When a human must act, it throws authorization_pending with the
// link to show them.
export async function ensureToken(api: string, auth: AuthClient, now: number): Promise<string> {
  // Resume before starting: the common path is a re-run after the user signed in,
  // and starting a second login would invalidate the code they just approved.
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
  // Persist before throwing: a link approved against a code we forgot is the one
  // failure with no recovery but starting over.
  credentials.save({ token: '', api, pending: fresh });
  throw waitingOn(fresh);
}

// cmdLogin authenticates this machine, resuming a login already in flight. When a
// human must act, ensureToken throws authorization_pending, rendered with the link.
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

// waitingOn is the message the agent relays. Addressed to the agent on purpose:
// the fix tells it not to open the URL or sign in itself.
function waitingOn(p: credentials.Pending): CliError {
  return new CliError(
    AuthCode.AuthorizationPending,
    `two80 needs your user to sign in: ${p.url} (code ${p.userCode})`,
    `show your user this link and code, wait for them to confirm, then run your command again: ${p.url} (code ${p.userCode})`,
  );
}
