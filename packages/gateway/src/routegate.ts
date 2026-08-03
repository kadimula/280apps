// Pure, DB-free route gating shared by the central gateway (in-process evaluate) and
// the app-Worker middleware (verify-and-forward). It depends only on @280/contracts,
// so importing it pulls in NO backend, DB, or secret material — the property the
// tenant Worker bundle relies on.

import { resolveRouteGate, routeGateSatisfied, type RouteGate } from '@280/contracts';

const NO_ACCESS = 'Ask the app owner to share it with you, then reload.';

// The effective role a token carries, the only input route gating needs beyond the
// declared routes.
export interface GateRoles {
  appRole: string;
  featureRole: string;
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

// gateForPath enforces the two-tier route model against a path with roles already
// resolved (from a verified token, no DB). An app that declares no routes keeps the
// flat "any admitted viewer reaches everything" model; once it declares any route the
// no-unguarded-route rule binds and an undeclared path resolves to the owner-only
// default.
export function gateForPath(routes: RouteGate[], roles: GateRoles, path: string): GateDecision {
  if (routes.length === 0) return { allow: true };
  const { gate, declared } = resolveRouteGate(routes, path);
  if (routeGateSatisfied(gate, roles)) return { allow: true };
  return { allow: false, reason: gateDenyReason(gate, declared) };
}

export function gateDenyReason(gate: RouteGate, declared: boolean): string {
  if (!declared) return 'This part of the app is limited to the owner.';
  if (gate.role !== '') return `This needs the "${gate.role}" role. Ask the owner to grant it.`;
  return NO_ACCESS;
}
