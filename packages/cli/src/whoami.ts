import * as output from './output.js';
import { resumeLogin } from './login.js';
import type { Ctx } from './app.js';
export const WHOAMI_HELP = `two80 whoami - print auth state

Examples:
  two80 whoami`;
export async function cmdWhoami(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;
  const p = output.parseFlags(s, 'whoami', ctx.args, []);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, WHOAMI_HELP);
    return output.ExitOK;
  }
  const { token } = await resumeLogin(ctx.api, ctx.deps.authClient(ctx.api), ctx.deps.now());
  if (token === '') {
    return output.result(s, { loggedIn: false, help: ['Run `two80 login`'] });
  }
  const port = await ctx.deps.openPort();
  const me = await port.whoami();
  return output.result(s, { loggedIn: true, user: me.email });
}
