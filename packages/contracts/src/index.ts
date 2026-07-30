// @280/contracts: the frozen deploy + auth contract shared by the CLI and
// platform. Spec is the Go contracts/ package (normative).

export * from './errors.js';
export * from './types.js';
export * from './port.js';
export * from './identity.js';
export * as version from './version.js';

// Runtime carriers and executable contract layered on the frozen wire types
// above, shared so consumers use one throwable error type and one conformance suite.
export { DeployErr, asDeployError } from './deploy/error.js';
export * as conformance from './deploy/conformance.js';
