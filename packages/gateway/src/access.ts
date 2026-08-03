// Authorization: the gateway's answer to "may this viewer open this app, and may
// they reach this path?" — the enforced core of the two-tier permission model
// (design §5.4, §07). It runs before the identity token is minted, and it is
// unbypassable because the container has no ingress but its app Worker, which
// forwards only a gateway-minted, locally-verified identity.
//
// Two layers, both fail-closed:
//   1. Open access. A grant (by email or by org domain) always admits; otherwise
//      the app's access mode decides — link (any signed-in viewer, as viewer) or
//      anyone-at-tenant (viewers whose org matches the owner's). invited denies.
//   2. Route gate. Every request path resolves to a gate: the most specific
//      declared route, or the owner-only default for an undeclared one (no
//      unguarded route). The viewer's effective app/feature role must satisfy it.
//
// "View as" lets an owner/admin preview the app as a lower role; it only ever
// changes what they see, never a stored grant, and is honored only when their real
// role is admin or above.

import {
  APP_ACCESS,
  appRoleAtLeast,
  resolveRouteGate,
  routeGateSatisfied,
  type AppPolicy,
  type RouteGate,
} from '@280/contracts';
import type { Grant } from '@280/backend/seams';
import type { VerifiedViewer } from './gateway.js';
import { gateDenyReason } from './routegate.js';

const NO_ACCESS = 'Ask the app owner to share it with you, then reload.';

// The access the gateway resolved for one viewer on one app: the effective app role
// and feature role that drive gating and get minted into the identity, plus the
// advisory data scope.
export interface EffectiveGrant {
  appRole: string;
  featureRole: string;
  dataScope: Record<string, unknown> | null;
}

const EMPTY_EFFECTIVE: EffectiveGrant = { appRole: '', featureRole: '', dataScope: null };

// The gate reported for an app that declares no routes: satisfied by any admitted
// viewer. Never used for matching, only to describe the decision.
const OPEN_GATE: RouteGate = { path: '', appRole: '', role: '' };

// A preview request parsed from the 280_view cookie: show the app as this app role
// and/or feature role. Honored only when the real viewer is admin or above.
export interface ViewAs {
  script: string;
  appRole: string;
  role: string;
}

// The store slice the authorizer needs. The full pg Store satisfies it
// structurally; a test double implements just these three.
export interface AccessReader {
  appByScript(script: string): Promise<{ id: string } | null>;
  grant(appId: string, principal: string): Promise<Grant | null>;
  appPolicy(appId: string): Promise<AppPolicy | null>;
}

export type Authorization =
  | { allow: false; reason: string; appId: string; effective: EffectiveGrant; viewAsApplied: boolean }
  | {
      allow: true;
      appId: string;
      effective: EffectiveGrant;
      gate: RouteGate;
      gateDeclared: boolean;
      viewAsApplied: boolean;
    };

export interface AuthzInput {
  viewer: VerifiedViewer;
  script: string;
  host: string;
  path: string;
  viewAs: ViewAs | null;
}

// The admission decision, split out of evaluate() so the central gateway can mint an
// identity token from it WITHOUT a path (route gating is enforced later, locally, in
// the app Worker against the token's roles). Admission needs the grants DB; route
// gating is pure and per-path, so keeping them separate is what lets one minted token
// serve many paths while gating stays real-time at the edge.
export type Admission =
  | { allow: false; reason: string; appId: string; effective: EffectiveGrant; viewAsApplied: boolean }
  | { allow: true; appId: string; effective: EffectiveGrant; viewAsApplied: boolean };

export class Authorizer {
  constructor(private readonly store: AccessReader) {}

  // admit resolves whether a viewer may open an app at all, and the effective grant
  // (app/feature role, scope) to snapshot into the identity token. No route gating.
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

    // Open access: a real grant always admits; otherwise the access mode may admit
    // the viewer at an implicit viewer role. No admission → hard deny.
    const openRole = admit(policy, real.appRole, input.viewer.tenant);
    if (openRole === null) {
      return { allow: false, reason: NO_ACCESS, appId: app.id, effective: real, viewAsApplied: false };
    }
    const admitted: EffectiveGrant = { ...real, appRole: openRole };

    // View-as overrides what an owner/admin sees, for this app only. Gated on the
    // REAL app role so a lower-privileged cookie has no effect.
    const useViewAs =
      input.viewAs !== null &&
      input.viewAs.script === input.script &&
      appRoleAtLeast(real.appRole, 'admin');
    const effective: EffectiveGrant = useViewAs
      ? { appRole: input.viewAs!.appRole || 'viewer', featureRole: input.viewAs!.role, dataScope: null }
      : admitted;

    return { allow: true, appId: app.id, effective, viewAsApplied: useViewAs };
  }

  async evaluate(input: AuthzInput): Promise<Authorization> {
    const adm = await this.admit({ viewer: input.viewer, script: input.script, viewAs: input.viewAs });
    if (!adm.allow) {
      return {
        allow: false,
        reason: adm.reason,
        appId: adm.appId,
        effective: adm.effective,
        viewAsApplied: adm.viewAsApplied,
      };
    }

    // Route gating is enforced here for the in-process path and, in the container-only
    // model, locally in the app Worker (gateSatisfiesPath) against the token's roles.
    const policy = await this.store.appPolicy(adm.appId);
    const routes = policy?.routes ?? [];
    if (routes.length === 0) {
      return { allow: true, appId: adm.appId, effective: adm.effective, gate: OPEN_GATE, gateDeclared: true, viewAsApplied: adm.viewAsApplied };
    }
    const { gate, declared } = resolveRouteGate(routes, input.path);
    if (!routeGateSatisfied(gate, adm.effective)) {
      return {
        allow: false,
        reason: gateDenyReason(gate, declared),
        appId: adm.appId,
        effective: adm.effective,
        viewAsApplied: adm.viewAsApplied,
      };
    }

    return { allow: true, appId: adm.appId, effective: adm.effective, gate, gateDeclared: declared, viewAsApplied: adm.viewAsApplied };
  }

  // viewAsAllowed authorizes setting a "view as" preview: it returns the app id when
  // the viewer's real role on the app is admin or above, else null. This is the same
  // real-role check evaluate() re-applies before honoring the cookie.
  async viewAsAllowed(script: string, email: string): Promise<string | null> {
    const app = await this.store.appByScript(script);
    if (app === null) return null;
    const real = await resolveEffectiveGrant(this.store, app.id, email);
    return appRoleAtLeast(real.appRole, 'admin') ? app.id : null;
  }
}

// admit decides whether a viewer with real app role `have` may open the app under
// its access mode, returning the app role to open with (their own, or an implicit
// 'viewer' for link/anyone-at-tenant openers), or null to deny.
function admit(policy: AppPolicy | null, have: string, viewerTenant: string): string | null {
  if (have !== '') return have;
  const access = policy?.access ?? APP_ACCESS.Invited;
  if (access === APP_ACCESS.Link) return 'viewer';
  if (
    access === APP_ACCESS.AnyoneAtTenant &&
    policy !== null &&
    policy.ownerTenant !== '' &&
    viewerTenant === policy.ownerTenant
  ) {
    return 'viewer';
  }
  return null;
}

// resolveEffectiveGrant merges the grants that could name this viewer — their exact
// address and their org by domain — into one effective grant: the higher app role
// wins, and the more specific (direct email) grant supplies the feature role and
// data scope, falling back to the domain grant.
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

// The principals a grant could name this viewer under: their exact address and,
// when the address has one, their org by domain.
function grantPrincipals(email: string): string[] {
  const at = email.lastIndexOf('@');
  const principals = [email];
  if (at >= 0) principals.push('domain:' + email.slice(at + 1).toLowerCase());
  return principals;
}
