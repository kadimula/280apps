// The signed identity scheme now lives in @280/contracts so the gateway (which
// mints it) and @280/sdk (which verifies it inside the app) share one definition
// and can never drift. Re-exported here so the gateway's own modules and tests keep
// importing it from a local path.

export {
  ID_HEADER,
  ID_TYP,
  ID_ALG,
  DEFAULT_TTL_SECS,
  DEFAULT_SKEW_SECS,
  IdentityError,
  IdentitySigner,
  IdentityVerifier,
  tenantFromEmail,
  publicJwkFromPrivate,
  type IdentityClaims,
  type VerifiedIdentity,
  type SignInput,
} from '@280/contracts';
