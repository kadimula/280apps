280apps.com is an opinionated platform which helps agents and teams securely build internal tools. The platform is built around three tenets:

**Tenet 1. Zero-trust for agent-generated code.**
Application code never holds or manages a credential (Google service-account JWTs, AWS SigV4, raw DB passwords, etc.); 280 injects it at the egress boundary.

**Tenet 2. Agents own deployment and debugging.**
An agent-optimized CLI handles all such housekeeping.

**Tenet 3. Humans own login, secrets, and access control.**
Granting access to trusted identities and entering secret values stay a human's job.

Following are the steps necessary to securely deploy to the platform.

## 1. Check app compatibility

280 supports most CRUD apps an internal team builds, but the support set is limited. Check https://280apps.com/platform-support.md first, review the user's stack, and install the CLI only if it is supported. (You can also offer to change the unsupported parts.)

## 2. Call provider APIs directly, not through credentialed SDKs

Before anything else, strip out every authenticated SDK. 280 injects credentials at the egress boundary, so the app must reach each provider over plain HTTP with no auth wiring of its own.

- Replace credentialed clients (`googleapis`, the AWS SDK, a Postgres client that takes a password, etc.) with direct calls to the provider's HTTP API: no keys, no request signing, no `Authorization` header, no connection string.
- Reach provisioned Postgres over its allowlisted HTTPS endpoint with a serverless driver, never a raw `:5432` connection.

280 attaches the credential in-flight from the `280.json` `egress` block (step 3); the value never enters the container. Land this refactor before you push.

## 3. Hand every secret to the platform

280 is zero-trust: it never lets your app hold a credential, so a leak, a stray log line, or compromised code can't expose one. Secrets are the platform's job. Two rules:

- **The app never holds a secret value** — no reading env, embedding in code, building auth headers, or logging. If the running app can see a credential, it's wrong.
- **The app never manages secrets** — write plain API calls with no auth wiring. 280 attaches the credential in-flight from `280.json`; the value never enters the container.

So your only task is to declare them. For each credential the app uses (env vars, API keys, connection strings, tokens), add its name to `secrets` and bind it to the host it authenticates against:

    {
      "secrets": ["<SECRET_NAME>"],
      "egress": {
        "allow": ["<api-host>"],
        "credentials": [{ "host": "<api-host>", "secret": "<SECRET_NAME>" }]
      }
    }

280 injects the value on requests to that host (`Authorization: Bearer` by default; set `"header"`/`"scheme"` to differ). Remove the app's own secret handling, and author names only — never write a value anywhere. Users enter values in the 280 dashboard (step 6).

## 4. Install the CLI and push

    npx -y two80@latest push

Auto-inits new projects. Safe to re-run; every step resumes, nothing duplicates.

## 5. Login (in the user's browser)

When push prints a login link, relay it and wait. Never open it yourself.

> Log in to 280 to deploy: <url>

After they confirm, push again.

## 6. Secret values (also the user's browser)

When push says it is waiting on secret values, relay the link and wait. Never ask for the values yourself.

> Enter values for STRIPE_KEY at: <url>

Push finishes on its own once they are saved. If it timed out waiting, push again.

## 7. Verify, then hand over the link

Push exits with the live URL. The edge can lag up to a minute.

- Broken or stale: wait 30 seconds, retry. Do not re-push yet.
- Still broken after two retries: fix, push again.
- Clean: give the user the live link.
