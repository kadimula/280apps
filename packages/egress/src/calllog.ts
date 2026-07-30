// The call-log: one event per outbound request the handler processes, the audit
// trail for "every outbound call is allowlisted and logged" (design §06). It
// records the destination, the outcome, and WHETHER a credential was attached —
// never the credential's value, and never a query string (which can carry tokens).

export type CallOutcome = 'forwarded' | 'denied' | 'error';

export interface CallLogEvent {
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

// A sink for call-log events. Swappable so the front can route events to a durable
// store, a queue, or analytics; the default writes a structured line the Workers
// runtime captures as a log. Kept synchronous and fire-and-forget so logging never
// gates or fails an outbound request.
export type CallLog = (event: CallLogEvent) => void;

// consoleCallLog emits one tagged JSON line per event. Cloudflare Workers Logs
// capture stdout, so this is a real audit sink for the MVP; a durable ingest is a
// drop-in replacement for this CallLog.
export const consoleCallLog: CallLog = (event) => {
  console.log('[280-egress] ' + JSON.stringify(event));
};

// noopCallLog discards events, for tests that do not assert on the audit trail.
export const noopCallLog: CallLog = () => {};
