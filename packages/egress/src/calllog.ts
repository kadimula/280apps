// The call-log: one event per outbound request the handler processes, the audit
// trail for "every outbound call is allowlisted and logged" (design §06). It
// records the destination, the outcome, and WHETHER a credential was attached —
// never the credential's value, and never a query string (which can carry tokens).

export type CallOutcome = 'forwarded' | 'denied' | 'error';

export interface CallLogEvent {
  kind: 'request'; // discriminates the request audit trail from mint events
  appId: string;
  host: string;
  method: string;
  path: string; // pathname only; the query is dropped so tokens never reach the log
  status: number; // upstream status, or 0 when the request never left (denied/error)
  credentialAttached: boolean;
  secret: string; // the secret's NAME, or '' — never its value
  outcome: CallOutcome;
  reason: string; // set for denied/error (e.g. 'missing-secret'), '' otherwise
  at: number; // unix ms
}

export type MintOutcome = 'minted' | 'cache' | 'failed';

// The mint audit event: one per attempt to mint a typed credential (e.g. a Google
// access token). Discriminated from CallLogEvent so a request event is never
// overloaded with token detail. It records only non-sensitive identifiers and the
// outcome — never the assertion, private key, access token, or provider response.
export interface MintEvent {
  kind: 'mint';
  appId: string;
  secret: string; // the secret's NAME, never its value
  type: string; // the credential type minted (e.g. google-service-account)
  scopes: string[]; // normalized scopes; deploy policy, safe to record
  expiresAtMs: number; // token expiry when minted/cached, 0 on failure
  outcome: MintOutcome;
  reason: string; // safe failure category on 'failed', '' otherwise — never a value
  at: number; // unix ms
}

export type EgressAuditEvent = CallLogEvent | MintEvent;

// A sink for call-log events. Swappable so the front can route events to a durable
// store, a queue, or analytics; the default writes a structured line the Workers
// runtime captures as a log. Kept synchronous and fire-and-forget so logging never
// gates or fails an outbound request.
export type CallLog = (event: CallLogEvent) => void;

// A sink for mint audit events, separate from CallLog so a request event is never
// overloaded with token detail. Same synchronous, fire-and-forget contract.
export type MintLog = (event: MintEvent) => void;

// consoleCallLog emits one tagged JSON line per event. Cloudflare Workers Logs
// capture stdout, so this is a real audit sink for the MVP; a durable ingest is a
// drop-in replacement for this CallLog.
export const consoleCallLog: CallLog = (event) => {
  console.log('[280-egress] ' + JSON.stringify(event));
};

export const consoleMintLog: MintLog = (event) => {
  console.log('[280-egress-mint] ' + JSON.stringify(event));
};
