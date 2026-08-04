// Admission: may this viewer open this app, and at what effective role? The enforced
// core of the two-tier model (design §5.4). A grant admits; otherwise the access mode
// decides (public, or anyone-at-tenant). Route gating is enforced later, per path.

import {
  APP_ACCESS,
  appRoleAtLeast,
  isConsumerEmailDomain,
  type AppPolicy,
} from '@280/contracts';
import type { Grant } from '@280/backend/seams';
import type { VerifiedViewer } from './gateway.js';

const NO_ACCESS = 'Ask the app owner to share it with you, then reload.';

export interface EffectiveGrant {
  appRole: string;
  featureRole: string;
  dataScope: Record<string, unknown> | null;
}

const EMPTY_EFFECTIVE: EffectiveGrant = { appRole: '', featureRole: '', dataScope: null };

// A preview target from the 280_view cookie, honored only when the real viewer is
// admin or above.
export interface ViewAs {
  script: string;
  appRole: string;
  role: string;
}

export interface AccessReader {
  appByScript(script: string): Promise<{ id: string } | null>;
  grant(appId: string, principal: string): Promise<Grant | null>;
  appPolicy(appId: string): Promise<AppPolicy | null>;
}

// The admission decision, carried to the mint site WITHOUT a path: route gating is
// enforced later and locally in the app Worker against the token's roles, so one
// minted token serves many paths while gating stays real-time at the edge.
export type Admission =
  | { allow: false; reason: string; appId: string; effective: EffectiveGrant; viewAsApplied: boolean }
  | { allow: true; appId: string; effective: EffectiveGrant; viewAsApplied: boolean };

export class Authorizer {
  constructor(private readonly store: AccessReader) {}

  async admit(input: { viewer: VerifiedViewer; script: string; viewAs: ViewAs | null }): Promise<Admission> {
    const app = await this.store.appByScript(input.script);
    // A missing app denies identically to a missing grant, so an outsider cannot
    // probe which apps are real.
    if (app === null) {
      return { allow: false, reason: NO_ACCESS, appId: '', effective: EMPTY_EFFECTIVE, viewAsApplied: false };
    }

    const [real, policy] = await Promise.all([
      resolveEffectiveGrant(this.store, app.id, input.viewer.email),
      this.store.appPolicy(app.id),
    ]);

    const openRole = admit(policy, real.appRole, input.viewer.tenant);
    if (openRole === null) {
      return { allow: false, reason: NO_ACCESS, appId: app.id, effective: real, viewAsApplied: false };
    }
    const admitted: EffectiveGrant = { ...real, appRole: openRole };

    // Gated on the REAL app role, so a lower-privileged cookie has no effect.
    const useViewAs =
      input.viewAs !== null &&
      input.viewAs.script === input.script &&
      appRoleAtLeast(real.appRole, 'admin');
    const effective: EffectiveGrant = useViewAs
      ? { appRole: input.viewAs!.appRole || 'viewer', featureRole: input.viewAs!.role, dataScope: null }
      : admitted;

    return { allow: true, appId: app.id, effective, viewAsApplied: useViewAs };
  }

  // Missing app and missing policy both answer null: anonymous serving is opt-in by
  // exactly one stored value, everything else fails closed to the login path.
  async publicAppId(script: string): Promise<string | null> {
    const app = await this.store.appByScript(script);
    if (app === null) return null;
    const policy = await this.store.appPolicy(app.id);
    return policy !== null && policy.access === APP_ACCESS.Public ? app.id : null;
  }

  // The same real-role check admit() re-applies before honoring a view-as cookie.
  async viewAsAllowed(script: string, email: string): Promise<string | null> {
    const app = await this.store.appByScript(script);
    if (app === null) return null;
    const real = await resolveEffectiveGrant(this.store, app.id, email);
    return appRoleAtLeast(real.appRole, 'admin') ? app.id : null;
  }
}

// A consumer-mail ownerTenant (gmail.com, …) never opens anyone-at-tenant: that dial
// position would mean "anyone at gmail.com", so it is treated as no-match.
function admit(policy: AppPolicy | null, have: string, viewerTenant: string): string | null {
  if (have !== '') return have;
  const access = policy?.access ?? APP_ACCESS.Invited;
  if (access === APP_ACCESS.Public) return 'viewer';
  if (
    access === APP_ACCESS.AnyoneAtTenant &&
    policy !== null &&
    policy.ownerTenant !== '' &&
    !isConsumerEmailDomain(policy.ownerTenant) &&
    viewerTenant === policy.ownerTenant
  ) {
    return 'viewer';
  }
  return null;
}

// The higher app role wins; the more specific (direct email) grant supplies the
// feature role and data scope, falling back to the domain grant.
export async function resolveEffectiveGrant(
  store: AccessReader,
  appId: string,
  email: string,
): Promise<EffectiveGrant> {
  const [direct, domain] = await Promise.all(
    grantPrincipals(email).map((p) => store.grant(appId, p)),
  );
  if (direct === null && domain === null) return { ...EMPTY_EFFECTIVE };

  const appRole = appRoleAtLeast(direct?.appRole ?? '', domain?.appRole ?? '')
    ? (direct?.appRole ?? '')
    : (domain?.appRole ?? '');
  const source = direct?.featureRole ? direct : domain?.featureRole ? domain : (direct ?? domain);
  return {
    appRole,
    featureRole: source?.featureRole ?? '',
    dataScope: source?.dataScope ?? null,
  };
}

function grantPrincipals(email: string): string[] {
  const at = email.lastIndexOf('@');
  const principals = [email];
  if (at >= 0) principals.push('domain:' + email.slice(at + 1).toLowerCase());
  return principals;
}
