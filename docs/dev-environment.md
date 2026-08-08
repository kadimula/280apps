# Development environment

For the serving and identity architecture (why apps are per-app Workers behind a central identity gateway), see [`architecture.md`](./architecture.md).

How the 280apps dev environment is wired, and how to target it. It mirrors
production but runs on parallel, isolated infrastructure so you can push and test
apps without touching real users' deploys.

For the full list of environment variables the backend and gateway read, see the
committed [`.env.example`](../.env.example) at the repo root.

## Dev vs prod at a glance

| | Production | Development |
| --- | --- | --- |
| Auth host (identity gateway) | `auth.280apps.run` | `auth-development.280apps.run` |
| App URLs | `*.280apps.run` | `*-development.280apps.run` |
| Control-plane API (`TWO80_API`) | `https://api.280apps.com` | `https://api-development.280apps.com` |
| Frontend origin (dashboard, `FRONTEND_ORIGIN`) | `https://console.280apps.com` | `https://dev-console.280apps.com` |
| Frame-ancestors (`APP_FRAME_ANCESTORS`) | `https://console.280apps.com` | `https://dev-console.280apps.com` |
| App host suffix (`APP_HOST_SUFFIX`) | *(empty)* | `-development` |

Note: the dev dashboard host `dev-console.280apps.com` uses a `dev-` prefix, not the
`*-development` suffix every other dev host follows. Keep it in sync with wherever the
dashboard is actually deployed; `APP_FRAME_ANCESTORS` must equal that origin or the
dashboard iframe preview is blocked by CSP.

Container-only serving: each dev app deploys as its own Cloudflare Worker and
serves at `*-development.280apps.run`; production apps serve at `*.280apps.run`.
Each app Worker calls the identity gateway (`auth[-development].280apps.run`) to
mint a signed identity, then forwards to its container. The `-development` host
label comes from `APP_HOST_SUFFIX`, which is inserted before
`APP_BASE_DOMAIN` (`280apps.run`).

## Targeting dev from the CLI

The CLI picks which control-plane backend to talk to from the `TWO80_API`
environment variable. It defaults to `https://api.280apps.com` (production). Point
it at the dev backend to push into the development environment:

```sh
TWO80_API=https://api-development.280apps.com npx -y two80@latest push
```

Everything else about the push flow is unchanged; only the backend URL differs.

## Railway development environment

The control-plane backend (`packages/backend`, the Node host in
`src/main.ts`) runs as a Railway service. It is built from
[`packages/backend/Dockerfile`](../packages/backend/Dockerfile):

- **Healthcheck:** `GET /healthz`
- **Port:** `8080` (the image `EXPOSE`s 8080; Railway also injects `PORT`, which
  the host honors first).
- **Blob storage:** a mounted Railway volume backs the filesystem blob store when
  the `BLOB_S3_*` vars are unset. Point `LOCAL_BLOB_DIRECTORY` at the volume mount path.

It is deployed as a `development` environment inside the `280-prod` Railway
project (a separate environment from `production`, with its own variables and its
own database).

### Dev variable manifest

NON-SECRET values are written literally. SECRETS are listed by NAME only; their
real values live outside the repo (Railway environment variables / a secrets
manager), never in git. See [`.env.example`](../.env.example) for every variable
the backend and gateway read, with comments.

Non-secret (safe to set literally in the dev environment):

```sh
APP_RUNTIME=container
BACKEND_API_ORIGIN=https://api-development.280apps.com
FRONTEND_ORIGIN=https://dev-console.280apps.com
APP_FRAME_ANCESTORS=https://dev-console.280apps.com
APP_BASE_DOMAIN=280apps.run
APP_HOST_SUFFIX=-development
SESSION_COOKIE_DOMAIN=.280apps.com
DATABASE_SCHEMA=platform
DEVICE_APPROVAL_URL=https://280apps.com/activate
LOG_FORMAT=json
```

Secrets (set in Railway, never committed — real values live outside the repo):

- `DATABASE_URL`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `DEPOT_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APP_SECRETS_KMS_KEY_NAME` (the environment's Cloud KMS key resource name)
- `APP_SECRETS_KMS_CREDENTIALS_JSON`
