// The seam's single error shape and its stable code taxonomy.
// Spec: contracts/deploy/deploy.go (Error, Code* consts, statusFor),
// contracts/auth/auth.go (device-flow codes). Go is normative.
//
// The error taxonomy, not the state machine, is the real contract with the
// agent: an error is either Retryable (transient; re-run the loop) or carries a
// non-empty Fix an agent can act on verbatim.

import { z } from 'zod';

// Deploy error codes (deploy.go:200-214).
export const DeployCode = {
  Unauthorized: 'unauthorized',
  AmbiguousIdentity: 'ambiguous_identity',
  NoSuchApp: 'no_such_app',
  PreflightRejected: 'preflight_rejected',
  DigestMismatch: 'digest_mismatch',
  InvalidBlob: 'invalid_blob',
  ConfirmationRequired: 'confirmation_required',
  NotFound: 'not_found',
  Unavailable: 'unavailable',
  CLITooOld: 'cli_too_old',
} as const;
export type DeployCode = (typeof DeployCode)[keyof typeof DeployCode];

// Device-flow codes (auth.go:19-23). Errors reuse the deploy Error shape so the
// CLI has exactly one error shape to render. AuthorizationPending is the
// expected answer for most of the flow's life, not a failure.
export const AuthCode = {
  AuthorizationPending: 'authorization_pending',
  ExpiredToken: 'expired_token',
  AccessDenied: 'access_denied',
} as const;
export type AuthCode = (typeof AuthCode)[keyof typeof AuthCode];

// Error is the seam's single error shape (deploy.go:220-226).
//
// Loose by construction (unknown fields preserved, absent optionals defaulted)
// to mirror Go encoding/json: a strict schema that rejects extra fields breaks
// old clients. Go omitempty semantics: absent fix => "", absent retryable =>
// false, absent candidates => [] (Go marshals a nil slice as absent/null).
export const errorSchema = z
  .object({
    code: z.string(),
    message: z.string().default(''),
    fix: z.string().nullish().transform((v) => v ?? ''),
    retryable: z.boolean().nullish().transform((v) => v ?? false),
    candidates: z
      .array(z.string())
      .nullish()
      .transform((v) => v ?? []),
  })
  .passthrough();

export type DeployError = {
  code: string;
  message: string;
  fix: string;
  retryable: boolean;
  candidates: string[];
};

// HTTP status mapping (api.go:600-618). Frozen with the codes it maps. Any code
// not listed is a 400 (Go's default arm), which includes the device-flow codes.
export const HTTP_STATUS: Readonly<Record<string, number>> = {
  [DeployCode.Unauthorized]: 401,
  [DeployCode.NoSuchApp]: 404,
  [DeployCode.NotFound]: 404,
  [DeployCode.AmbiguousIdentity]: 409,
  [DeployCode.InvalidBlob]: 409,
  [DeployCode.PreflightRejected]: 422,
  [DeployCode.DigestMismatch]: 422,
  [DeployCode.ConfirmationRequired]: 428,
  [DeployCode.CLITooOld]: 426,
  [DeployCode.Unavailable]: 503,
};

export const DEFAULT_STATUS = 400;

// statusForCode mirrors api.go statusFor.
export function statusForCode(code: string): number {
  return HTTP_STATUS[code] ?? DEFAULT_STATUS;
}
