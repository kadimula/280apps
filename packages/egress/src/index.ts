// @280/egress: the outbound data path. A front (the appcontainer worker or the
// phase-2 gateway) registers the egress handler on the container class and applies
// each app's policy per instance; the handler attaches vault-held credentials to
// allowlisted outbound requests in-flight and logs every call. Default-deny and the
// fail-closed allowlist gate are enforced by @cloudflare/containers itself (spike
// §2/§3); this package owns the credential injection, the audit trail, and the
// footgun-safe wiring.

export type {
  EgressPolicy,
  EgressCredential,
  ContainerStub,
  EgressContainerClass,
  OutboundHandler,
  OutboundHandlerCtx,
  OutboundByHostEntry,
  EgressCallParams,
} from './types.js';

export type { Vault } from './vault.js';
export { envVault, mapVault } from './vault.js';

export type {
  CallLog,
  CallLogEvent,
  CallOutcome,
  MintLog,
  MintEvent,
  MintOutcome,
  EgressAuditEvent,
} from './calllog.js';
export { consoleCallLog, consoleMintLog } from './calllog.js';

export type {
  Minter,
  MinterDeps,
  MintInput,
  MintResult,
  MintFailureCategory,
} from './minters.js';
export { makeMinters, MintError } from './minters.js';

export type { EgressHandlerOptions } from './handler.js';
export { makeEgressHandler } from './handler.js';

export { registerEgress, applyEgressPolicy, EGRESS_HANDLER_NAME } from './register.js';
