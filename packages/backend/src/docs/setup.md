280apps.com is an opinionated platform which helps agents and teams securely build internal tools. The platform is built around three tenets:

**Tenet 1. Zero-trust for agent-generated code.**
Application code never sees or manages credentials (Google service-account JWTs, AWS SigV4, raw DB passwords, etc.)

**Tenet 2. Agents own deployment and debugging.**
An agent-optimized CLI handles all housekeeping.

**Tenet 3. Humans own login, secrets, and access control.**
Granting access to trusted identities and entering secret values stay a human's job.

Following are the steps necessary to securely deploy to the platform.

## 1. Check app compatibility

280 runs most CRUD apps a team builds, but the support set is limited. Check the user's stack against these tables before installing the CLI; offer to change any unsupported parts.

**Supported**

| Stack | Notes |
| --- | --- |
| Static HTML | Any static site (HTML, CSS, JS, assets); served with SPA fallback to index.html |
| Next.js | Full Node 20 container, so SSR, API routes, SSG/ISR, Server Actions, middleware, next/image, and native/WASM deps all work |

Any other stack ships a repo root Dockerfile that listens on port 8080 (the platform sets `PORT=8080`); Next.js and static sites build automatically.

**Not supported**

| Not supported | Do this instead |
| --- | --- |
| Inline credentials the app never reads (keys, tokens, connection strings) | Declare a `secret` bound to its host; 280 injects it at egress (steps 2 and 3) |
| Values the app must read (resource ids, regions, public client ids, flags) | Declare them in `config`; 280 sets them as env vars the app reads (step 4) |
| Authenticated SDKs (`googleapis`, AWS SDK, password-based Postgres clients) | Call the provider's HTTP API directly (step 2) |
| Unrestricted outbound network | Allowlist every host in `280.json` `egress.allow` (others get HTTP 520) |
| Raw TCP outbound (Postgres on `:5432`) | Reach the database over its HTTPS endpoint |
| Background work while idle (`setInterval`, polling loops) | An instance sleeps after ~2 min idle; use request handlers |
| Websockets | Poll instead |

## 2. Call provider APIs directly, not through credentialed SDKs

Before anything else, strip out every authenticated SDK. 280 injects credentials at the egress boundary, so the app must reach each provider over plain HTTP with no auth wiring of its own.

- Replace credentialed clients (`googleapis`, the AWS SDK, a Postgres client that takes a password, etc.) with direct calls to the provider's HTTP API: no keys, no request signing, no `Authorization` header, no connection string.
- Reach provisioned Postgres over its allowlisted HTTPS endpoint with a serverless driver, never a raw `:5432` connection.

280 attaches the credential in-flight from the `280.json` `egress` block (step 3); the value never enters the container. Land this refactor before you push.

## 3. Hand every secret to the platform

280 is zero-trust: it never lets your app hold a credential, so a leak, a stray log line, or compromised code can't expose one. Secrets are the platform's job. Two rules:

- **The app never holds a secret value** — no reading env, embedding in code, building auth headers, or logging. If the running app can see a credential, it's wrong.
- **The app never manages secrets** — write plain API calls with no auth wiring. 280 attaches the credential in-flight from `280.json`; the value never enters the container.

The test is simple: **a value is a secret only if the app never reads it.** A credential the app hands to no code (an API key, a service-account JSON, a connection token) is a secret; 280 attaches it at egress. A value the app *does* read to work (a resource id, a region, a public client id) is **config**, not a secret: declare it in `config` instead (step 4).

So your only task is to declare each secret and bind it to the host it authenticates against:

    {
      "egress": {
        "credentials": [{ "host": "<api-host>", "secret": "<SECRET_NAME>" }]
      }
    }

Binding a secret to a host is what declares it: you do not repeat it in a top-level `secrets` list, and you do not add its host to `allow` (a credentialed host is allowed automatically). 280 injects the value on requests to that host (`Authorization: Bearer` by default; set `"header"`/`"scheme"` to differ). Remove the app's own secret handling, and author names only — never write a value anywhere. Users enter values in the 280 dashboard (step 7).

## 4. Declare config the app reads

Config is the mirror of secrets: values the app **reads** with `process.env` to function (resource ids, regions, public client ids, feature flags, internal hostnames). Never a credential — if the app never reads it, it is a secret (step 3). Declare config as a map of env-var name to value:

    {
      "config": {
        "REGION": "us-east-1",
        "SHEET_ID": { "sensitive": true }
      }
    }

Two forms:

- **`"NAME": "value"`** — a committed-public value. It lives in `280.json`, so editing it redeploys.
- **`"NAME": { "sensitive": true }`** — a value the user enters in the dashboard (step 7); it is stored encrypted, kept out of logs, and the deploy waits until it is set. Use this for a mildly confidential value the app still reads (a private resource id, an internal host). It stays config — the app reads it — it is never promoted to a secret.

Each declared name arrives as an environment variable in the container, so the app reads it directly:

    const sheetId = process.env.SHEET_ID;

Names must be valid env identifiers; `PORT`, `HOSTNAME`, `NODE_ENV`, `NODE_EXTRA_CA_CERTS`, and the `TWO80_` prefix are reserved.

## 5. Install the CLI and push

    npx -y two80@latest push

Auto-inits new projects. Safe to re-run; every step resumes, nothing duplicates.

## 6. Login (in the user's browser)

When push prints a login link, relay it and wait. Never open it yourself.

> Log in to 280 to deploy: <url>

After they confirm, push again.

## 7. Variable values (also the user's browser)

When push exits reporting missing values, relay the link and ask the user to enter them. Never ask for the values yourself. This covers both secrets and dashboard-entered (`sensitive`) config — the dashboard calls them variables.

> Enter values for STRIPE_KEY at: <url>

Push does not wait: once the user confirms the values are saved, run `two80 push` again to resume.

## 8. Verify, then hand over the link

Push exits with the live URL. The edge can lag up to a minute.

- Broken or stale: wait 30 seconds, retry. Do not re-push yet.
- Still broken after two retries: fix, push again.
- Clean: give the user the live link.
