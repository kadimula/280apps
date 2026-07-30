# @280/gateway

The edge identity gateway: the only public entry to apps on `*.280apps.run`. It
authenticates a viewer, holds their session, and hands app code a verified
identity. This is the dispatcher (`platform/dispatcher`) grown from a
hostname→script pipe into a front door — same routing skeleton (`src/hosts.ts`),
now with OIDC + sessions + a signed identity header in front of the proxy.

It runs on Cloudflare Workers as a **platform** piece, independent of the app
container runtime. The deployable entrypoint is `src/worker.ts` (wrangler
`main`); `src/index.ts` is the library surface tests and the future `@280/sdk`
verify against.

## Request flow

Per request the gateway makes four moves, each a named seam:

1. **Classify the host** (`hosts.ts`) — the canonical auth host, an app host, or
   neither.
2. **Resolve the session** — the control plane's `Auth` service (reused), over a
   cookie scoped to `.280apps.run`. No session → bounce through OIDC.
3. **Check access** (`access.ts`) — `AllowAllAccess` today; the grants check
   slots in here (see Seams).
4. **Mint identity + proxy** — sign a short-lived header for this app host, strip
   any client-supplied `x-280-*` headers, forward to the upstream
   (`StubUpstream` today).

The OIDC handshake lives on one fixed host (`auth.280apps.run`) because an IdP
`redirect_uri` must be a registered exact URL, and `*.280apps.run` has
unboundedly many app hosts. Every login funnels through that host; the session
cookie it sets (domain `.280apps.run`) is what every app host then reads.

```
viewer → renewals.280apps.run          (no session)
       ← 302 auth.280apps.run/login?return=…
       → auth.280apps.run/auth/<google|microsoft>/start
       ← 302 IdP consent
       → auth.280apps.run/auth/<provider>/callback   (sets 280_session on .280apps.run)
       ← 302 renewals.280apps.run
       → renewals.280apps.run          (session ✓) → [access] → X-280-Identity → upstream
```

## Sign-in providers

Google and Microsoft Entra are both `OidcProvider` implementations
(`@280/backend/auth/oidc`) driven through one code path; adding a provider is one
registry entry. Entra uses the **multi-tenant `/organizations`** authority
(design §5.3): a single app registration each customer's admin consents to once.

## Signed identity header (report OQ8)

The header app code reads is `X-280-Identity`: a compact JWS the gateway mints
and the app verifies **offline**, without calling the gateway.

- **Algorithm.** ECDSA P-256 / SHA-256 (JOSE `ES256`). Asymmetric on purpose:
  the gateway holds the **private** key and is the only party that can *mint* an
  identity; every app holds only the **public** key and can *verify* but never
  forge. A symmetric HMAC would hand each app a secret that also mints
  identities for every other app.
- **Format.** `base64url(header).base64url(payload).base64url(signature)`.
  - header: `{ "alg": "ES256", "kid": "<key id>", "typ": "280-identity+jwt" }`
  - payload claims:

    | claim    | meaning                                                        |
    |----------|----------------------------------------------------------------|
    | `iss`    | issuer, e.g. `https://auth.280apps.run`                         |
    | `aud`    | the app host, e.g. `renewals.280apps.run` — binds the header to one app |
    | `sub`    | platform user id (`usr_…`), stable across logins               |
    | `email`  | gateway-verified address                                       |
    | `tenant` | org (email domain in MVP; see note)                            |
    | `name`   | display name                                                   |
    | `iat`/`exp` | minted-at / expiry                                          |
- **TTL.** 120s (`TWO80_ID_TTL_SECS`). The header is re-minted on every proxied
  request, so a leaked one dies in seconds. Verification allows 30s clock skew.
- **Key custody & rotation.** The private key is an ECDSA P-256 **JWK** held only
  as the `ID_SIGNING_JWK` Workers Secret, tagged with `kid`. The public JWK Set
  is served at `/.well-known/280-identity.jwks` and handed to apps at deploy.
  Rotate by publishing a new public key under a new `kid`, then flipping the
  signing key — a verifier that carries both `kid`s never sees a gap.
- **Verification** (`IdentityVerifier`, what the SDK wraps): checks `typ`,
  pins `alg` to `ES256` (closes `alg:none`/confusion), looks up the `kid`,
  verifies the signature, then checks `exp`/`iat` (with skew), `iss`, and `aud`
  against the app's own host.
- **Anti-spoofing.** The gateway strips every inbound `x-280-*` header before
  setting its own, so a viewer cannot inject a forged identity.

Generate a signing key:

```
node scripts/gen-signing-key.mjs
wrangler secret put ID_SIGNING_JWK   # paste the private JWK line
```

Note: `tenant` is the email domain in MVP (matches design §5.5 `"evergreen.com"`).
Entra's stable tenant authority is the `tid` GUID; carrying it is a follow-up
that needs `OidcIdentity` to surface `tid` — a claim addition, not a format
change.

## Seams (where the trailing work slots in)

- **App-access check** (`access.ts`) — `AllowAllAccess` passes every
  authenticated viewer. Swap it for a grants-backed `AccessCheck` (task
  `280-p2-gateway`); nothing else on the path moves.
- **Upstream** (`upstream.ts`) — `StubUpstream` echoes the request. The real
  target is the app container (design §04) or, on the WfP substrate, the
  dispatch-namespace binding. Implement one more `Upstream`; the gateway is
  unchanged.

## Deploy

`wrangler.jsonc` (prod) / `wrangler.development.jsonc` (dev) route
`*.280apps.run/*`. The gateway **supersedes** `platform/dispatcher` on this
route — only one Worker may own it, so cutover is a deploy-time step. It shares
the control plane's Hyperdrive/Postgres (same user/session tables). Secrets:
`GOOGLE_CLIENT_ID/SECRET`, `ENTRA_CLIENT_ID/SECRET`, `ID_SIGNING_JWK`.
