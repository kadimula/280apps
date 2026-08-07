# Architecture: serving and identity

How a 280 app is served, and how a signed-in viewer's identity reaches it. This is
the shape of the system and the reasoning behind it. For the dev-specific hosts,
namespaces, and CLI targeting, see [`dev-environment.md`](./dev-environment.md).

## Why this shape

280 apps are deployed by coding agents on behalf of non-technical builders, and
every app needs a signed-in viewer with the right access. Apps must therefore hold
zero login code: identity is a **platform** concern, enforced at a single front
door, not re-implemented per app. The whole design follows from putting that front
door in exactly one place and keeping the app side incapable of forging identity.

## Serving model

Each app runs container-only as its **own Cloudflare Worker on its own route**
(`<script>[-development].280apps.run/*`), serving its own per-app container image
(`App280Container`, `platform/appcontainer/`) via `getContainer`. Routing is by
per-app Cloudflare routes, so there is no dynamic dispatch. Workers-for-Platforms
and the edge dispatcher that preceded this are gone.

A single central **identity gateway** Worker (`packages/gateway`, deployed as
`280-gateway` / `280-gateway-development` on `auth[-development].280apps.run`) is
the platform front door. It is a decision and mint service, never a traffic proxy:
it owns login, the platform database, and the identity signing key, but app traffic
never passes through it on the hot path.

## Identity design: mint centrally, verify locally (topology A2)

The gateway is the **only** holder of three things: the private ES256 identity
signing key (`ID_SIGNING_JWK`), the platform Postgres (grants, sessions, audit),
and central OIDC (Google/Microsoft). On a cache miss or expiry, a per-app Worker
calls the gateway over an internal service binding (`GATEWAY.mint(...)`, a
binding-only `WorkerEntrypoint` — never HTTP-reachable). The gateway resolves the
viewer's session, evaluates access and the effective grant against the DB, and
mints a short-lived signed identity token scoped to that one app host.

Each app Worker then works entirely from that token. It holds only the **public**
JWK set (fetched over the binding, cached ~300s) plus pure verify-and-forward logic
(`packages/gateway/src/appworker.ts`). On the hot path it:

1. reads the host-only `280_id` cookie and verifies the token locally with WebCrypto
   — **zero network**;
2. enforces the route gate locally against the app's baked policy and the token's
   roles (`resolveRouteGate` / `routeGateSatisfied` in `@280/contracts`);
3. stamps `X-280-Identity` (`packages/contracts/src/identity.ts`, the one shared
   sign/verify module) and hands off to the container.

Only login and token mint/refresh touch the central gateway. A steady user painting
pages within a live token makes zero central calls; expiry triggers a single silent
re-mint over the binding, no browser redirect.

### The snapshot vs real-time split

- **Snapshotted into the token (DB-backed, frozen for its TTL):** who the viewer is,
  plus the admission result and effective grant (`appRole`, feature `role`, `caps`,
  `scope`). Resolved once at mint because they need the grants DB.
- **Real-time, per request, local:** the route gate, run in the app Worker with no
  network. Possession of a valid, correctly-audienced, unexpired token *is* proof of
  admission at mint time; the gate decides per-path access from the snapshotted roles.

### Concrete parameters

- **Token TTL: 30s.** A grant change, role change, or forced logout must reflect at
  the app quickly; a 30s TTL bounds the stale-authz window to one token lifetime.
- **Edge skew: 5s.** The app-Worker verifier accepts a token until `exp + skew`.
  Cloudflare edge clocks are NTP-tight, so 5s absorbs real jitter without inflating
  the window (the library default 30s skew would silently double the bound). 5s is
  the practical floor below which benign jitter causes false "expired" re-mints.
- **Grant-revocation bound: ~35s** (30s TTL + 5s skew). There is no instant hard
  revoke; a revoked grant or deleted session takes effect at the next mint, which the
  live token defers by at most this window.

**Audience-scoping is the cross-app firewall:** a token's `aud` is the specific app
host it was minted for, so app B rejects a token minted for app A.

### Carriage

- **Browser ⇄ app Worker:** the `280_id` cookie, **host-only** (`HttpOnly; Secure;
  SameSite=Lax; Path=/`, no `Domain`) so a token never leaks to another app host.
- **SSO session:** the `280_session` cookie on `.280apps.run` — one central login
  shared across all app hosts. App hosts receive the session, never another app's id
  token.
- **App Worker ⇄ container:** the `X-280-Identity` header, which `@280/sdk` verifies
  offline inside the container.

## Why A2, and not A1 (the key decision)

The tempting literal design (A1) compiles the full auth pipeline — signing key, DB
connection, OIDC — into *every* per-app Worker. That is a multi-tenant security
regression: **compromising any one app Worker would let it forge identity for all
apps** and would scatter DB credentials across every tenant.

A2 keeps the signing key, the platform DB, and OIDC in the central gateway only.
App Workers hold nothing secret — just the public verify key and pure code — so an
app compromise can read a request but cannot mint an identity for itself or any
other app. The cost is one internal service-binding hop on mint (not per request);
the short-TTL locally-verified token is precisely what keeps that hop off the hot
path while preserving the "single front door holds the key" property. Blast radius
stays contained to the compromised app.

## Build and deploy topology

App images are built with **Depot** (daemonless remote BuildKit): one
`depot build --push` per app to `registry.cloudflare.com`
(`packages/backend/src/runtime/container/`, `depot-builder.ts`). The roll is a plain
`wrangler deploy --containers-rollout immediate` against a generated container
config whose `image` is the pre-built registry ref, so no Docker runs on the roll.
`rollConfig` emits the per-app route, the `GATEWAY` service binding, and the baked
identity/route policy vars (`registry-builder.ts`). The control-plane backend
(`@280/backend`) runs as **Node on Railway** with **PostgreSQL** and **R2** as
the image-registry backing. Dev runs the same shapes on isolated infra; see
[`dev-environment.md`](./dev-environment.md).

## Key rotation

ES256 keys carry a `kid`. Because app Workers hold only public JWKS fetched from the
gateway, rotation needs zero tenant redeploys: publish the new public key alongside
the old, wait past the JWKS cache TTL, flip the central signer to the new `kid`
(an unknown `kid` forces an immediate refetch rather than a failure), wait past
token TTL + skew + cache TTL, then retire the old key.
