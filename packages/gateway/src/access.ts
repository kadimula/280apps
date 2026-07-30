// The app-access seam: "may this viewer open this app?"
// SEAM (280-p2-gateway): swap AllowAllAccess for a grants-backed check here;
// nothing else on the request path moves.

import type { VerifiedViewer } from './gateway.js';

export type AccessDecision = { allow: true } | { allow: false; reason: string };

export interface AccessCheck {
  check(input: { viewer: VerifiedViewer; appScript: string; host: string }): Promise<AccessDecision>;
}

// MVP stand-in: authentication is enforced upstream, authorization is not yet.
export class AllowAllAccess implements AccessCheck {
  async check(): Promise<AccessDecision> {
    return { allow: true };
  }
}
