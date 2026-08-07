// The egress DATA PATH mirrored inline from the tested @280/egress package
// (packages/egress): the credential-injecting outbound handler and the per-app
// policy application. Kept dependency-free (no @cloudflare/containers import) so it
// loads in the Workers runtime and under test in isolation. Keep in step with
// packages/egress (packages/egress/test/exfil.test.ts).

// The single named handler every allowlisted host is routed through. Registering a
// NAMED handler (not a per-host function map) is what lets the front bind hosts at
// runtime via setOutboundByHost(host, EGRESS_HANDLER, params) — only strings and
// JSON cross the Durable Object boundary, so the secret's NAME travels while its
// VALUE stays Worker-side. Mirrors @280/egress EGRESS_HANDLER_NAME.
export const EGRESS_HANDLER = 'egress';

// The only credential type this floor injects. A credential carrying any other
// type is a typed credential a later handler version owns (e.g. a service-account
// JSON minted into a short-lived token). This floor must NOT treat it as a static
// header — that would put the whole secret value (private key included) on the
// wire — so an unknown type fails closed before the vault is ever read. Absent or
// empty type means the static header form.
const HEADER_TYPE = 'header';

function unsupportedType(type) {
  return type !== undefined && type !== '' && type !== HEADER_TYPE;
}

// The outbound handler runs in the Workers runtime, outside the container sandbox.
// `env` is the Worker env (the vault); it reads the secret by name and attaches it
// in-flight, so the container's image/env/code never hold the credential. Every
// call is logged (destination + whether a credential was attached, never its value).
export function egressHandler(req, env, ctx) {
  const p = ctx.params || {};
  const url = new URL(req.url);
  const host = p.host || url.hostname;
  const event = { appId: p.appId || '', host, method: req.method, path: url.pathname, at: Date.now() };

  // Fail closed on a credential type this floor does not implement, before reading
  // the vault: never forward it, and never fall through to raw header injection.
  if (unsupportedType(p.type)) {
    console.log('[280-egress] ' + JSON.stringify({ ...event, status: 0, credentialAttached: false, secret: p.secret || '', outcome: 'denied', reason: 'unsupported-type' }));
    return new Response('Origin is disallowed', { status: 520 });
  }

  if (p.secret) {
    const value = env && typeof env[p.secret] === 'string' ? env[p.secret] : undefined;
    if (!value) {
      // Fail closed: a credentialed host with no provisioned secret is not forwarded.
      console.log('[280-egress] ' + JSON.stringify({ ...event, status: 0, credentialAttached: false, secret: p.secret, outcome: 'denied', reason: 'missing-secret' }));
      return new Response('Origin is disallowed', { status: 520 });
    }
    const headers = new Headers(req.headers);
    headers.set(p.header || 'authorization', p.scheme ? `${p.scheme} ${value}` : value);
    return fetch(new Request(req, { headers })).then((res) => {
      console.log('[280-egress] ' + JSON.stringify({ ...event, status: res.status, credentialAttached: true, secret: p.secret, outcome: 'forwarded' }));
      return res;
    });
  }
  return fetch(req).then((res) => {
    console.log('[280-egress] ' + JSON.stringify({ ...event, status: res.status, credentialAttached: false, secret: '', outcome: 'forwarded' }));
    return res;
  });
}

// applyEgressPolicy pushes one app's 280.json-derived policy onto a running
// instance: setAllowedHosts is the fail-closed security boundary (anything not
// listed → 520 at the container gate), and every allowed host is routed through the
// egress handler so each call is logged and its credential (if any) attached. The
// credential's `type` is propagated so the handler can reject a type it does not
// implement — dropping it here would defeat the handler's fail-closed guard.
export async function applyEgressPolicy(stub, policy, appId) {
  const hosts = (policy?.allowedHosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  await stub.setAllowedHosts(hosts);
  const byHost = {};
  for (const host of hosts) {
    const cred = (policy.credentials || []).find((c) => c.host === host);
    byHost[host] = {
      method: EGRESS_HANDLER,
      params: {
        appId: appId || '',
        host,
        secret: cred?.secret || '',
        header: cred?.header || 'authorization',
        scheme: cred?.scheme ?? 'Bearer',
        type: cred?.type || '',
      },
    };
  }
  await stub.setOutboundByHosts(byHost);
}
