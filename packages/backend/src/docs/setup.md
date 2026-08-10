280apps.com is an opinionated platform which helps agents and teams securely build internal tools. The platform is built around three tenets:

**Tenet 1. Zero trust for agent generated code.**
Application code never sees or manages provider credentials.

**Tenet 2. Agents own deployment and debugging.**
An agent optimized CLI handles all housekeeping.

**Tenet 3. Humans own login and access control.**
Granting access to trusted identities stays a human's job.

Following are the steps necessary to securely deploy to the platform.

## 1. Check app compatibility

280 runs most CRUD apps a team builds, but the support set is limited. Check the user's stack against these tables before installing the CLI; offer to change any unsupported parts.

**Supported**

| Stack | Notes |
| --- | --- |
| Static HTML | Any static site with HTML, CSS, JS, and assets; served with SPA fallback to index.html |
| Next.js | Full Node 20 container, so SSR, API routes, SSG or ISR, Server Actions, middleware, next/image, and native or WASM dependencies work |

Any other stack ships a repo root Dockerfile that listens on port 8080. Next.js and static sites build automatically.

**Not supported**

| Not supported | Do this instead |
| --- | --- |
| Direct calls to external APIs | Use `@two80/sdk`; the container can only reach the 280 API |
| Authenticated provider SDKs | Use the corresponding `@two80/sdk` capability when available |
| Raw TCP outbound | Use the corresponding `@two80/sdk` capability when available |
| App managed credentials | Remove them from application code and configuration |
| Background work while idle | An instance sleeps after about 2 minutes idle; use request handlers |
| Websockets | Poll instead |

## 2. Use the 280 SDK for platform capabilities

The container has a fixed network boundary. It can reach the 280 API and no other host. Do not call provider APIs directly and do not add an `egress` block to `280.json`.

Install the SDK:

    npm install @two80/sdk

Use SDK capabilities for database, file, and integration access as they become available. The SDK reads the platform supplied `TWO80_API` origin. Never override that environment variable.

The SDK is an application API, not the security boundary. Cloudflare enforces the one host network rule, and the 280 API authorizes every operation for the current app and user.

## 3. Remove credentials from the app

Remove API keys, access tokens, service account files, connection strings, provider SDK authentication, and code that builds authorization headers. Do not put credentials in `280.json`, source files, environment files, Docker build arguments, or application logs.

If a required provider capability does not exist in `@two80/sdk`, report it as unsupported rather than weakening the network boundary.

## 4. Declare config the app reads

Config is a value the app reads with `process.env` to function, such as a resource id, region, public client id, feature flag, or internal display setting. It must never be a credential. Declare config as a map from environment variable name to value:

    {
      "config": {
        "REGION": "us-east-1",
        "SHEET_ID": { "sensitive": true }
      }
    }

Two forms:

1. `"NAME": "value"`: a committed public value. It lives in `280.json`, so editing it redeploys.
2. `"NAME": { "sensitive": true }`: a value the user enters in the dashboard. It is stored encrypted, kept out of logs, and the deploy waits until it is set. The running app can read it, so it is config rather than a credential.

Each declared name arrives as an environment variable in the container:

    const sheetId = process.env.SHEET_ID;

Names must be valid environment identifiers. `PORT`, `HOSTNAME`, `NODE_ENV`, `NODE_EXTRA_CA_CERTS`, `TWO80_API`, and the `TWO80_` prefix are reserved.

## 5. Install the CLI and push

    npx -y two80@latest push

This initializes new projects automatically. It is safe to run again because every step resumes without duplication.

## 6. Login in the user's browser

When push prints a login link, relay it and wait. Never open it yourself.

> Log in to 280 to deploy: <url>

After the user confirms, push again.

## 7. Config values in the user's browser

When push exits reporting missing values, relay the link and ask the user to enter them. Never ask for the values yourself.

Push does not wait. Once the user confirms that values are saved, run `two80 push` again to resume.

## 8. Verify, then hand over the link

Push exits with the live URL. The edge can lag up to a minute.

1. If broken or stale, wait 30 seconds and retry. Do not push again yet.
2. If still broken after two retries, fix it and push again.
3. If clean, give the user the live link.
