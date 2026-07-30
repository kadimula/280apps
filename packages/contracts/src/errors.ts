// The seam's single error shape and its stable code taxonomy: the real contract
// with the agent. An error is either Retryable (transient; re-run the loop) or
// carries a non-empty Fix. Spec: contracts/deploy/deploy.go, contracts/auth/auth.go (normative).

import { z } from 'zod';

// Deploy error codes.
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

// Device-flow codes, reusing the deploy Error shape so the CLI renders one shape.
// AuthorizationPending is the expected answer for most of the flow's life, not a failure.
export const AuthCode = {
  AuthorizationPending: 'authorization_pending',
  ExpiredToken: 'expired_token',
  AccessDenied: 'access_denied',
} as const;
export type AuthCode = (typeof AuthCode)[keyof typeof AuthCode];

// Loose by construction to mirror Go encoding/json (a strict schema rejecting extra
// fields breaks old clients): absent fix => "", retryable => false, candidates => [].
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

// Any code not listed maps to 400 (the default arm), which includes the device-flow codes.
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

export function statusForCode(code: string): number {
  return HTTP_STATUS[code] ?? DEFAULT_STATUS;
}
