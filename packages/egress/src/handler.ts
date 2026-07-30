// The outbound handler: it runs in the Workers runtime (outside the container
// sandbox), attaches the app's credential in-flight, logs the call, and forwards.
// The container makes a plain request with no auth; this handler adds it from the
// vault so the secret is never in the container's image, env, or code.

import type { CallLog } from './calllog.js';
import { consoleCallLog } from './calllog.js';
import type { EgressCallParams, OutboundHandler } from './types.js';
import type { Vault } from './vault.js';
import { envVault } from './vault.js';

// Returned to the container when a credentialed host has no provisioned secret.
// Matches the container library's own fail-closed body/status so the app sees one
// consistent "blocked" signal whether the block came from the allowlist gate or here.
const DISALLOWED = 'Origin is disallowed';
const DISALLOWED_STATUS = 520;

export interface EgressHandlerOptions {
  // Where secret values come from, given the Worker env at call time. Defaults to
  // the Worker env itself (envVault); overridden in tests with an in-memory vault.
  vaultFrom?: (env: unknown) => Vault;
  // The audit sink; defaults to a structured log line.
  callLog?: CallLog;
  // The fetch used to reach upstream; defaults to the global fetch. Injected in
  // tests so no real network is touched.
  fetchImpl?: typeof fetch;
}

function asParams(raw: unknown): EgressCallParams {
  const p = (raw ?? {}) as Partial<EgressCallParams>;
  return {
    appId: p.appId ?? '',
    host: p.host ?? '',
    secret: p.secret ?? '',
    header: p.header || 'authorization',
    scheme: p.scheme ?? '',
  };
}

// makeEgressHandler builds the single named handler registered on the container
// class. It is generic: the per-host secret name and header wiring arrive as
// ctx.params, so one handler serves every allowlisted host of every app.
export function makeEgressHandler(opts: EgressHandlerOptions = {}): OutboundHandler {
  const vaultFrom = opts.vaultFrom ?? envVault;
  const callLog = opts.callLog ?? consoleCallLog;
  const doFetch = opts.fetchImpl ?? fetch;

  return async (req, env, ctx) => {
    const params = asParams(ctx.params);
    const url = new URL(req.url);
    const host = params.host || url.hostname;
    const method = req.method;
    const path = url.pathname; // query intentionally omitted from the audit trail
    const now = Date.now();

    let outReq = req;
    let credentialAttached = false;
    if (params.secret) {
      const value = vaultFrom(env).get(params.secret);
      if (!value) {
        // Fail closed: the app declared a credentialed host but the vault has no
        // value. Do not forward an un-credentialed request to an authed API.
        callLog({
          appId: params.appId,
          host,
          method,
          path,
          status: 0,
          credentialAttached: false,
          secret: params.secret,
          outcome: 'denied',
          reason: 'missing-secret',
          at: now,
        });
        return new Response(DISALLOWED, { status: DISALLOWED_STATUS });
      }
      const headers = new Headers(req.headers);
      headers.set(params.header, params.scheme ? `${params.scheme} ${value}` : value);
      outReq = new Request(req, { headers });
      credentialAttached = true;
    }

    try {
      const res = await doFetch(outReq);
      callLog({
        appId: params.appId,
        host,
        method,
        path,
        status: res.status,
        credentialAttached,
        secret: params.secret,
        outcome: 'forwarded',
        reason: '',
        at: now,
      });
      return res;
    } catch (err) {
      callLog({
        appId: params.appId,
        host,
        method,
        path,
        status: 0,
        credentialAttached,
        secret: params.secret,
        outcome: 'error',
        reason: err instanceof Error ? err.message : String(err),
        at: now,
      });
      throw err;
    }
  };
}
