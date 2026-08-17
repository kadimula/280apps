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
