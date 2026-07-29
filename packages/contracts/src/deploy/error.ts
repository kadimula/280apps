// The throwable form of the seam's single error shape. Spec: contracts/deploy/
// deploy.go (the *Error struct implementing the error interface, and AsError).
// Go is normative.
//
// errors.ts froze the wire shape (the plain object + loose zod schema); this is
// the runtime carrier every Port adapter throws and every caller catches. It is
// the exact TS analogue of Go's `*deploy.Error`: a value that both satisfies the
// error contract (extends Error) and carries the seam's typed fields.

import type { DeployError } from '../errors.js';

// DeployErr is the seam's error as a throwable. Its fields mirror deploy.Error:
// an error is either Retryable (transient; re-run the loop) or carries a
// non-empty Fix an agent can act on verbatim.
export class DeployErr extends Error implements DeployError {
  readonly code: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly candidates: string[];

  constructor(fields: {
    code: string;
    message?: string;
    fix?: string;
    retryable?: boolean;
    candidates?: string[];
  }) {
    super(fields.message ?? '');
    this.name = 'DeployErr';
    this.code = fields.code;
    this.fix = fields.fix ?? '';
    this.retryable = fields.retryable ?? false;
    this.candidates = fields.candidates ?? [];
  }
}

// asDeployError unwraps a caught value to the seam's typed error, mirroring
// deploy.AsError. Returns undefined when the value is not one.
export function asDeployError(err: unknown): DeployErr | undefined {
  return err instanceof DeployErr ? err : undefined;
}
