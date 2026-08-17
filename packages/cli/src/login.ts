import { AuthCode, type DeviceCodeResponse } from '@280/contracts';
import * as credentials from './credentials.js';
import * as output from './output.js';
import { CliError, asError } from './output.js';
import type { Ctx } from './app.js';
const LOGIN_HELP = `two80 login - authenticate this machine; prints a link to show your user, then
re-run to finish. Never waits.

Examples:
  two80 login`;
export interface AuthClient {
  start(): Promise<DeviceCodeResponse>; // POST /v1/device/code
  redeem(deviceCode: string): Promise<string>; // POST /v1/device/token -> token; throws on pending/expired/denied
}
export interface Resume {
  token: string; // non-empty => logged in
  pending?: credentials.Pending; // set => a login is in flight the human has not confirmed
}
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
export async function ensureToken(api: string, auth: AuthClient, now: number): Promise<string> {
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
  credentials.save({ token: '', api, pending: fresh });
  throw waitingOn(fresh);
}
export async function cmdLogin(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;
  const p = output.parseFlags(s, 'login', ctx.args, []);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, LOGIN_HELP);
    return output.ExitOK;
  }
  await ensureToken(ctx.api, ctx.deps.authClient(ctx.api), ctx.deps.now());
  return output.result(s, { loggedIn: true, api: ctx.api });
}
function waitingOn(p: credentials.Pending): CliError {
  return new CliError(
    AuthCode.AuthorizationPending,
    `two80 needs your user to sign in: ${p.url} (code ${p.userCode})`,
    `show your user this link and code, wait for them to confirm, then run your command again: ${p.url} (code ${p.userCode})`,
  );
}
