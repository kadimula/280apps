280apps.com deploys apps for small teams and manages their auth and permissions.

You and the human build the features; 280 owns deploy, identity, and permissions. It is agent first: nearly everything runs through the CLI. The human only logs in and sets secrets and permissions in the 280 UI.

## 1. Check app compatibility

280 supports most CRUD apps an internal team builds, but the support set is limited. Check https://280apps.com/platform-support.md first, review the user's stack, and install the CLI only if it is supported. (You can also offer to change the unsupported parts.)

## 2. Hand every secret to the platform

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

280 injects the value on requests to that host (`Authorization: Bearer` by default; set `"header"`/`"scheme"` to differ). Remove the app's own secret handling, and author names only — never write a value anywhere. Users enter values in the 280 dashboard (step 5).

## 3. Install the CLI and push

    npx -y two80@latest push

Auto-inits new projects. Safe to re-run; every step resumes, nothing duplicates.

## 4. Login (in the user's browser)

When push prints a login link, relay it and wait. Never open it yourself.

> Log in to 280 to deploy: <url>

After they confirm, push again.

## 5. Secret values (also the user's browser)

When push says it is waiting on secret values, relay the link and wait. Never ask for the values yourself.

> Enter values for STRIPE_KEY at: <url>

Push finishes on its own once they are saved. If it timed out waiting, push again.

## 6. Verify, then hand over the link

Push exits with the live URL. The edge can lag up to a minute.

- Broken or stale: wait 30 seconds, retry. Do not re-push yet.
- Still broken after two retries: fix, push again.
- Clean: give the user the live link.
