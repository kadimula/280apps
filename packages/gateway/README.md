# @280/gateway

The central identity authority for apps on `*.280apps.run`. It authenticates a
viewer, holds their session, and mints a verified, app-scoped identity token.
Container-only serving: the gateway is **not** an app proxy. It owns only the
auth host (`auth.280apps.run`) over HTTP, and over a service binding it mints
identity tokens for the per-app Workers. Each app is its own Cloudflare Worker on
its own `<script>.280apps.run/*` route; that Worker's middleware (`appworker.ts`)
calls the gateway to mint, verifies the token offline, enforces its route gates,
and forwards to its own container.

It runs on Cloudflare Workers as a **platform** piece, independent of the app
container runtime. The deployable entrypoint is `src/worker.ts` (wrangler
`main`): a `fetch` handler for the auth host plus `GatewayRPC` (the `mint`/`jwks`
service-binding surface). `src/index.ts` is the library surface tests and
`@280/sdk` verify against.

## Request flow

An app host is served by the app's own Worker. On a request with no valid local
token, its middleware calls the gateway's `mint` over the service binding, which
makes three moves — each a named seam:

1. **Resolve the session** — the control plane's `Auth` service (reused), over a
   cookie scoped to `.280apps.run`. No session → return a login URL the app
   Worker 302s the viewer to.
2. **Admit** (`access.ts`) — `Authorizer.admit` reads the flat grants table
   (design §5.4): a viewer opens an app only with a grant naming them by email or
   covering their org by domain, or the app's open-access mode. No grant is a hard
   deny. Route gates are NOT applied here — one token serves many paths.
3. **Mint identity** — sign a short-lived token bound to this app host and hand it
   back. The app Worker delivers it as the host-only `280_id` cookie, then verifies
   it offline and enforces its route gates locally against the token's roles.

The OIDC handshake lives on one fixed host (`auth.280apps.run`) because an IdP
`redirect_uri` must be a registered exact URL, and `*.280apps.run` has
unboundedly many app hosts. Every login funnels through that host; the session
cookie it sets (domain `.280apps.run`) is what the app Workers then present when
they call `mint`.

```
viewer → renewals.280apps.run          (no session)  [app Worker → gateway.mint → login]
       ← 302 auth.280apps.run/login?return=…
       → auth.280apps.run/auth/<google|microsoft>/start
       ← 302 IdP consent
       → auth.280apps.run/auth/<provider>/callback   (sets 280_session on .280apps.run)
       ← 302 renewals.280apps.run
       → renewals.280apps.run   (session ✓) → app Worker → gateway.mint → 280_id token
                                            → verify offline → [route gate] → X-280-Identity → container
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
- **TTL.** 30s in production (`TWO80_ID_TTL_SECS`; config default 120). The app
  Worker re-mints once the `280_id` token expires, so a leaked one dies in seconds.
  Verification allows a tight edge clock skew (5s).
- **Key custody & rotation.** The private key is an ECDSA P-256 **JWK** held only
  as the `ID_SIGNING_JWK` Workers Secret, tagged with `kid`. The public JWK Set
  is served at `/.well-known/280-identity.jwks` and handed to apps at deploy.
  Rotate by publishing a new public key under a new `kid`, then flipping the
  signing key — a verifier that carries both `kid`s never sees a gap.
- **Verification** (`IdentityVerifier`, what the SDK wraps): checks `typ`,
  pins `alg` to `ES256` (closes `alg:none`/confusion), looks up the `kid`,
  verifies the signature, then checks `exp`/`iat` (with skew), `iss`, and `aud`
  against the app's own host.
- **Anti-spoofing.** The app Worker strips every inbound `x-280-*` header before
  stamping the verified one (`stampIdentity`), so a viewer cannot inject a forged
  identity.

Generate a signing key:

```
node scripts/gen-signing-key.mjs
wrangler secret put ID_SIGNING_JWK   # paste the private JWK line
```

Note: `tenant` is the email domain in MVP (matches design §5.5 `"evergreen.com"`).
Entra's stable tenant authority is the `tid` GUID; carrying it is a follow-up
that needs `OidcIdentity` to surface `tid` — a claim addition, not a format
change.

## App access

- **App-access check** (`access.ts`) — `Authorizer` reads the flat grants table
  through the `Store` seam: `appByScript` resolves the host label to an app id,
  then a grant lookup on the viewer's email and their `domain:<org>` decides. Any
  match allows; none is a hard deny, and a missing app denies identically so app
  existence is not probeable. `admit` decides admission for `mint`, with no path;
  route gating is applied later and locally by the app Worker.
- **Route gating** happens in the app Worker (`appworker.ts` `gateForPath`)
  against the baked policy and the token's roles, so one 30s token serves many
  paths without a central round-trip.

## Deploy

`wrangler.jsonc` (prod) / `wrangler.development.jsonc` (dev) route only the auth
host (`auth[-development].280apps.run/*`); each app Worker owns its own
`<script>.280apps.run/*` route (emitted by the roll). The gateway shares the
control plane's Hyperdrive/Postgres (same user/session tables). Secrets:
`GOOGLE_CLIENT_ID/SECRET`, `ENTRA_CLIENT_ID/SECRET`, `ID_SIGNING_JWK`.
