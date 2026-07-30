// The app-access seam: "may this viewer open this app?" A viewer reaches an app
// only with a grant for it (design §5.4). The grant may name them directly by
// email or cover their whole org by domain; either lets them in, any missing
// grant is a hard deny. Enforced here, before the identity header is minted or
// the request is proxied.

import type { VerifiedViewer } from './gateway.js';
import { tenantFromEmail } from './identity.js';

export type AccessDecision = { allow: true } | { allow: false; reason: string };

export interface AccessCheck {
  check(input: { viewer: VerifiedViewer; appScript: string; host: string }): Promise<AccessDecision>;
}

// The read surface the access check needs from the Store; the full pg Store
// satisfies it structurally, and a test double implements just these two.
export interface GrantsReader {
  appByScript(script: string): Promise<{ id: string } | null>;
  grant(appId: string, principal: string): Promise<{ appRole: string } | null>;
}

const NO_ACCESS = 'Ask the app owner to share it with you, then reload.';

// Denies a viewer with no grant for the app, and denies identically when the app
// does not exist so an outsider cannot probe which apps are real.
export class GrantsAccess implements AccessCheck {
  constructor(private readonly store: GrantsReader) {}

  async check(input: { viewer: VerifiedViewer; appScript: string; host: string }): Promise<AccessDecision> {
    const app = await this.store.appByScript(input.appScript);
    if (app === null) return { allow: false, reason: NO_ACCESS };

    const grants = await Promise.all(
      grantPrincipals(input.viewer.email).map((p) => this.store.grant(app.id, p)),
    );
    if (grants.some((g) => g !== null)) return { allow: true };
    return { allow: false, reason: NO_ACCESS };
  }
}

// The principals a grant could name this viewer under: their exact address and,
// when the address has one, their org by domain (design's `domain:firm.com`).
function grantPrincipals(email: string): string[] {
  const principals = [email];
  const domain = tenantFromEmail(email);
  if (domain !== '') principals.push('domain:' + domain);
  return principals;
}
