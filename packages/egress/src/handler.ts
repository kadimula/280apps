// The outbound handler: it runs in the Workers runtime (outside the container
// sandbox), attaches the app's credential in-flight, logs the call, and forwards.
// The container makes a plain request with no auth; this handler adds it from the
// vault so the secret is never in the container's image, env, or code. The credential
// is produced by a minter chosen from a closed type registry: `header` reproduces the
// original static injection, `google-service-account` mints a scoped token. An unknown
// type fails closed (520) and never falls through to static injection.

import { credentialType, CREDENTIAL_FIELDS, EGRESS_CREDENTIAL_TYPE } from '@280/contracts';
import type { CallLog, MintLog } from './calllog.js';
import { consoleCallLog, consoleMintLog } from './calllog.js';
import type { Minter, MintInput } from './minters.js';
import { makeMinters, MintError } from './minters.js';
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
  // The mint audit sink; defaults to a structured log line.
  mintLog?: MintLog;
  // The fetch used to reach upstream; defaults to the global fetch. Injected in
  // tests so no real network is touched.
  fetchImpl?: typeof fetch;
  // The clock, injected for deterministic cache/expiry tests. Defaults to Date.now.
  clock?: () => number;
  // WebCrypto, injected in tests. Defaults to the runtime's global crypto.
  crypto?: Crypto;
}

function asParams(raw: unknown): EgressCallParams {
  const p = (raw ?? {}) as Partial<EgressCallParams>;
  const secrets =
    p.secrets && typeof p.secrets === 'object' && !Array.isArray(p.secrets)
      ? (p.secrets as Record<string, string>)
      : undefined;
  return {
    appId: p.appId ?? '',
    host: p.host ?? '',
    secret: p.secret ?? '',
    secrets,
    type: p.type ?? '',
    header: p.header || 'authorization',
    scheme: p.scheme ?? '',
    scopes: Array.isArray(p.scopes) ? p.scopes : [],
  };
}

// The credential a request binds, resolved to NAMEs the vault is asked for. `label`
// is the audit identity: the single NAME, or the field NAMEs joined in fixed order
// (never a value). `fields` pairs each field role with its NAME for the multi-field form.
interface CredentialBinding {
  names: string[];
  label: string;
  fields?: { role: string; name: string }[];
}

function bindingFor(params: EgressCallParams, type: string): CredentialBinding {
  const map = params.secrets ?? {};
  if (Object.keys(map).length > 0) {
    const order = CREDENTIAL_FIELDS[type] ?? Object.keys(map).sort();
    const fields = order
      .map((role) => ({ role, name: map[role] }))
      .filter((p): p is { role: string; name: string } => typeof p.name === 'string' && p.name !== '');
    const names = fields.map((p) => p.name);
    return { names, label: names.join('+'), fields };
  }
  return { names: params.secret ? [params.secret] : [], label: params.secret };
}

function mintInput(
  params: EgressCallParams,
  label: string,
  resolved: Record<string, string>,
  binding: CredentialBinding,
): MintInput {
  const base = {
    appId: params.appId,
    secret: label,
    host: params.host,
    scopes: params.scopes,
    header: params.header,
    scheme: params.scheme,
  };
  if (binding.fields) {
    const fields = Object.fromEntries(binding.fields.map((p) => [p.role, resolved[p.name]!]));
    return { ...base, value: '', fields };
  }
  return { ...base, value: resolved[binding.names[0]!]! };
}

// makeEgressHandler builds the single named handler registered on the container
// class. It is generic: the per-host secret name, credential type, and header/scope
// wiring arrive as ctx.params, so one handler serves every allowlisted host of every
// app. The minter registry is per-isolate (built once here), so the token cache lives
// for the isolate's lifetime.
export function makeEgressHandler(opts: EgressHandlerOptions = {}): OutboundHandler {
  const vaultFrom = opts.vaultFrom ?? envVault;
  const callLog = opts.callLog ?? consoleCallLog;
  const mintLog = opts.mintLog ?? consoleMintLog;
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? (() => Date.now());
  const minters = makeMinters({
    fetchImpl: doFetch,
    now: clock,
    crypto: opts.crypto ?? crypto,
  });

  return async (req, env, ctx) => {
    const params = asParams(ctx.params);
    const url = new URL(req.url);
    const host = params.host || url.hostname;
    const method = req.method;
    const path = url.pathname; // query intentionally omitted from the audit trail
    const now = clock();
    const type = credentialType(params);
    const minted = type !== EGRESS_CREDENTIAL_TYPE.Header;
    const binding = bindingFor(params, type);
    const secretLabel = binding.label;

    let outReq = req;
    let credentialAttached = false;
    let activeMinter: Minter | undefined;
    let activeCacheKey: string | undefined;

    if (binding.names.length > 0) {
      const vault = vaultFrom(env);
      const resolved: Record<string, string> = {};
      let missing = false;
      for (const name of binding.names) {
        const value = vault.get(name);
        if (!value) {
          missing = true;
          break;
        }
        resolved[name] = value;
      }
      if (missing) {
        // Fail closed: the app declared a credentialed host but the vault has no value
        // for at least one field. Do not forward an un-credentialed request.
        callLog({
          kind: 'request',
          appId: params.appId,
          host,
          method,
          path,
          status: 0,
          credentialAttached: false,
          secret: secretLabel,
          outcome: 'denied',
          reason: 'missing-secret',
          at: now,
        });
        return new Response(DISALLOWED, { status: DISALLOWED_STATUS });
      }

      const minter = minters[type];
      const input = mintInput(params, secretLabel, resolved, binding);
      if (!minter) {
        return failMint(params, secretLabel, host, method, path, now, 'mint-failed', callLog, mintLog);
      }

      let result;
      try {
        result = await minter.mint(input);
      } catch (err) {
        const reason = err instanceof MintError ? err.category : 'mint-failed';
        return failMint(params, secretLabel, host, method, path, now, reason, callLog, mintLog, minted);
      }

      if (minted) {
        mintLog({
          kind: 'mint',
          appId: params.appId,
          secret: secretLabel,
          type,
          scopes: params.scopes,
          expiresAtMs: result.expiresAtMs,
          outcome: result.cached ? 'cache' : 'minted',
          reason: '',
          at: now,
        });
        activeMinter = minter;
        activeCacheKey = result.cacheKey;
      }

      const headers = new Headers(req.headers);
      headers.set(result.header, result.value);
      outReq = new Request(req, { headers });
      credentialAttached = true;
    }

    try {
      const res = await doFetch(outReq);
      // A downstream 401 means the minted token is stale/revoked: evict so the next
      // call re-mints. (Google may keep already-minted tokens valid after key
      // deletion, so this converges only on the next call, not instantly.)
      if (res.status === 401 && activeMinter?.invalidate && activeCacheKey) {
        activeMinter.invalidate(activeCacheKey);
      }
      callLog({
        kind: 'request',
        appId: params.appId,
        host,
        method,
        path,
        status: res.status,
        credentialAttached,
        secret: secretLabel,
        outcome: 'forwarded',
        reason: '',
        at: now,
      });
      return res;
    } catch (err) {
      callLog({
        kind: 'request',
        appId: params.appId,
        host,
        method,
        path,
        status: 0,
        credentialAttached,
        secret: secretLabel,
        outcome: 'error',
        reason: err instanceof Error ? err.message : String(err),
        at: now,
      });
      throw err;
    }
  };
}

// Emit the safe failure audit and return the fixed 520. The 520 body carries only the
// value-free category; no assertion, key, token, or provider response is ever in it.
function failMint(
  params: EgressCallParams,
  secretLabel: string,
  host: string,
  method: string,
  path: string,
  now: number,
  reason: string,
  callLog: CallLog,
  mintLog: MintLog,
  emitMintEvent = true,
): Response {
  if (emitMintEvent) {
    mintLog({
      kind: 'mint',
      appId: params.appId,
      secret: secretLabel,
      type: params.type,
      scopes: params.scopes,
      expiresAtMs: 0,
      outcome: 'failed',
      reason,
      at: now,
    });
  }
  callLog({
    kind: 'request',
    appId: params.appId,
    host,
    method,
    path,
    status: 0,
    credentialAttached: false,
    secret: secretLabel,
    outcome: 'denied',
    reason,
    at: now,
  });
  return new Response(reason, { status: DISALLOWED_STATUS });
}
