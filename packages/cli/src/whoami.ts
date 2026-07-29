// whoami reports auth state, finishing a device login the user approved since
// the last command ran. Reading the credentials file alone would answer "not
// logged in" for the whole window between the user confirming the code and some
// later command happening to redeem it, a false negative on the check an agent
// makes before deciding whether to ask its user to sign in again. A login still
// awaiting the human is honestly "not logged in": whoami keeps its two answers.
//
// Both answers are exit 0. whoami's intent is "report auth state", and "not
// logged in" satisfies it: a definitive state, not a failure (AXI §5). This
// diverges from Go's exit-1 on purpose.

import * as output from './output.js';
import { resumeLogin } from './login.js';
import type { Ctx } from './app.js';

export const WHOAMI_HELP = `280 whoami - print auth state

Examples:
  280 whoami`;

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
    // Definitive state, exit 0; the help line is the runnable next step. `280
    // login` also resumes a pending device flow, so it covers both branches.
    return output.result(s, { loggedIn: false, api: ctx.api, help: ['Run `280 login`'] });
  }
  // Self-contained: a confirmed answer, no next-step suggestions (AXI §9).
  return output.result(s, { loggedIn: true, api: ctx.api });
}
