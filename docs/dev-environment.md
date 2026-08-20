# Development environment

The development environment mirrors production on isolated Railway, Postgres,
Cloudflare, and KMS resources.

The platform derives its complete host topology from two canonical domains and an
environment name. Railway supplies `RAILWAY_ENVIRONMENT_NAME` to the backend. The
development gateway sets `DEPLOYMENT_ENVIRONMENT=development` in its Wrangler
configuration.

| Surface | Production | Development |
| --- | --- | --- |
| Dashboard | `https://280apps.com` | `https://development.280apps.com` |
| Control plane API | `https://api.280apps.com` | `https://api-development.280apps.com` |
| Authentication | `https://auth.280apps.run` | `https://auth-development.280apps.run` |
| App URLs | `*.280apps.run` | `*-development.280apps.run` |

The backend and gateway both receive the same canonical domains.

```sh
PLATFORM_DOMAIN=280apps.com
APP_SERVING_DOMAIN=280apps.run
```

These values derive the dashboard and API origins, activation URL, frame ancestor,
authentication host, identity issuer, gateway service, app hostname suffix, and
cookie configuration. Those derived values must not be configured independently.

## Targeting development from the CLI

```sh
TWO80_API=https://api-development.280apps.com npx -y two80@latest push
```

## Running an app locally against real integrations

An app built on `@two80/sdk` reaches its integration data from `next dev` with no
gateway and no local infra. The SDK falls back to the developer's own credential:

1. `two80 login` (writes the machine token and API origin to `~/.280/credentials`).
2. `two80 push` once (writes the resolved `appId` to `.280/config.json` and creates
   the app so its integrations can be connected in the dashboard).
3. `next dev`.

When no gateway identity header is present, `@two80/sdk` authenticates SDK calls with
that machine token and sends the app id as `X-280-Dev-App`. The backend resolves the
token to its owner, confirms the owner owns the named app, and serves as that owner.
This path is owner-only and never impersonates another viewer, so `can()`/`scope()`
authorization is not exercised locally (that remains gateway territory). Override the
origin, token, or app with `TWO80_API`, `TWO80_TOKEN`, `TWO80_APP`. In a deployed
container the gateway always injects the identity header, so this fallback never runs.

## Railway backend

The backend runs from `packages/backend/Dockerfile`. Railway supplies the port,
environment name, and volume mount path. The backend stores blobs under the
`blobs` directory inside the Railway volume when S3 configuration is absent.

Configure these nonsecret values in both Railway environments.

```sh
PLATFORM_DOMAIN=280apps.com
APP_SERVING_DOMAIN=280apps.run
DEPOT_BUILD_PROJECT_ID=<project id>
```

Configure these secrets separately in each environment.

```sh
DATABASE_URL
DEPOT_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_DEPLOY_API_TOKEN
GOOGLE_OIDC_CLIENT_ID
GOOGLE_OIDC_CLIENT_SECRET
APP_SECRET_KMS_KEY_NAME
APP_SECRET_KMS_CREDENTIALS_JSON
```

The complete local configuration reference is `.env.example`.

## Migration order

Deploy the backend and gateway code before removing legacy variables or gateway
secrets. During the migration, set the new names first, deploy, verify health,
login, device activation, and an app redirect, then remove the old names. The old
names are not compatibility aliases in code.
