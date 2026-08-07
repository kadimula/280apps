280apps.com deploys apps for small teams and manages their auth and permissions.

You and the human build the features; 280 owns deploy, identity, and permissions. It is agent first: nearly everything runs through the CLI. The human only logs in and sets secrets and permissions in the 280 UI.

## 1. Check app compatibility

280 supports most CRUD apps an internal team builds, but the support set is limited. Check https://280apps.com/platform-support.md first, review the user's stack, and install the CLI only if it is supported. (You can also offer to change the unsupported parts.)

## 2. Declare the app's secrets

Scan the repo for credentials the app uses: env vars, API keys, connection strings, tokens in code. Declare each name in `280.json` and map it to the host it authenticates against:

    {
      "secrets": ["STRIPE_KEY"],
      "egress": { "allow": ["api.stripe.com"], "credentials": [{ "host": "api.stripe.com", "secret": "STRIPE_KEY" }] }
    }

280 attaches the value to outbound requests to that host (an `Authorization: Bearer` header by default; set `"header"`/`"scheme"` for APIs that differ), so remove code that reads the value from env. You handle names only: never write a value into any file or into the conversation. The user enters values in the 280 dashboard.

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
