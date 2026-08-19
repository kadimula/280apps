// The throwable form of the seam's single error shape (errors.ts froze the wire
// shape): the runtime carrier every Port adapter throws and every caller catches.
// Spec: contracts/deploy/deploy.go (normative).

import type { DeployError } from '../errors.js';

// Either Retryable (transient; re-run the loop) or carries a non-empty Fix an agent can act on.
export class DeployErr extends Error implements DeployError {
  readonly code: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly candidates: string[];
  // Client-side only: the HTTP adapter fabricated this error by status class because
  // the body was not a structured error. Never serialized; means "the server did not say this".
  readonly synthesized: boolean;

  constructor(fields: {
    code: string;
    message?: string;
    fix?: string;
    retryable?: boolean;
    candidates?: string[];
    synthesized?: boolean;
  }) {
    super(fields.message ?? '');
    this.name = 'DeployErr';
    this.code = fields.code;
    this.fix = fields.fix ?? '';
    this.retryable = fields.retryable ?? false;
    this.candidates = fields.candidates ?? [];
    this.synthesized = fields.synthesized ?? false;
  }
}

// Unwraps a caught value to the seam's typed error, or undefined when it is not one.
export function asDeployError(err: unknown): DeployErr | undefined {
  return err instanceof DeployErr ? err : undefined;
}
