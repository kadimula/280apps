// @280/contracts: the frozen deploy + auth contract shared by the CLI and
// platform. Types, loose zod schemas, the deploy Port, error taxonomy, content
// derivations, and version ordering. Spec is the Go contracts/ package; Go is
// normative (plan §3).

export * from './errors.js';
export * from './types.js';
export * from './port.js';
export * as version from './version.js';

// Deploy adapters (W1). The wire types/derivations/Port above are frozen; these
// are the runtime carriers and executable contract layered on top, exposed so
// consumers (the platform, the CLI, the cross-conformance harness) share one
// throwable error type and one conformance suite instead of re-deriving them.
export { DeployErr, asDeployError } from './deploy/error.js';
export * as conformance from './deploy/conformance.js';
