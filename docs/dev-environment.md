# Development environment

How the 280apps dev environment is wired, and how to target it. It mirrors
production but runs on parallel, isolated infrastructure so you can push and test
apps without touching real users' deploys.

For the full list of environment variables the backend and gateway read, see the
committed [`.env.example`](../.env.example) at the repo root.

## Dev vs prod at a glance

| | Production | Development |
| --- | --- | --- |
| Dispatch namespace (Workers for Platforms) | `apps` | `apps-development` |
| App URLs | `*.280apps.run` | `*-development.280apps.run` |
| Control-plane API (`TWO80_API`) | `https://api.280apps.com` | `https://api-development.280apps.com` |
| Frontend origin | `https://www.280apps.com` | `https://www-development.280apps.com` |
| App host suffix (`TWO80_APP_HOST_SUFFIX`) | *(empty)* | `-development` |

Dev apps deploy to the `apps-development` Workers-for-Platforms dispatch namespace
and serve at `*-development.280apps.run`. Production apps deploy to the `apps`
namespace and serve at `*.280apps.run`. The `-development` host label comes from
`TWO80_APP_HOST_SUFFIX`, which is inserted before `TWO80_APP_DOMAIN` (`280apps.run`).

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
  the `TWO80_S3_*` vars are unset. Point `TWO80_BLOBS` at the volume mount path.

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
TWO80_RUNTIME=container
TWO80_BUILDER=depot
TWO80_API_ORIGIN=https://api-development.280apps.com
TWO80_FRONTEND_ORIGIN=https://www-development.280apps.com
TWO80_APP_DOMAIN=280apps.run
TWO80_APP_HOST_SUFFIX=-development
TWO80_COOKIE_DOMAIN=.280apps.com
TWO80_DB_SCHEMA=platform
TWO80_VERIFICATION_URI=https://280apps.com/activate
TWO80_LOG_FORMAT=json
```

Secrets (set in Railway, never committed — real values live outside the repo):

- `DATABASE_URL`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `DEPOT_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
