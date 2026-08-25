280apps.com securely deploys internal tools built by agents. The agent owns deploy and debugging through the CLI, and the human owns login and access control through the UI. Credentials live in the platform, never in the code.

Full runtime and platform reference: https://280apps.com/capabilities.md

## Deploy procedure

1. **Keep credentials out of the codebase.** Every API key, token, connection string, or provider secret the app needs is declared in `280.json` as a `sensitive` config variable with an empty value, never hardcoded. The user enters each one in the dashboard; the platform stores it encrypted and injects it into the container as a Cloudflare secret, so the app reads it from `process.env.NAME` and it is never committed or logged:

        { "config": [
          { "name": "STRIPE_SECRET_KEY", "value": "", "sensitive": true },
          { "name": "AWS_REGION", "value": "us-east-1", "sensitive": false }
        ] }

   Non-secret ids, regions, and flags carry a committed `value` and ship as plain env vars. The container reaches the internet directly, so use each provider's own SDK or API with these credentials.

2. **Use `@two80/sdk` for identity and access control.** The gateway signs a verified identity for every request. Read it with `identity(request)` to get `{ user, can, scope }`; gate features with `can("...")` and declare roles and access modes in `280.json`. The app never handles login or verifies the identity itself.

3. **Push.**

        npx -y two80@latest push

   This auto-initializes new projects and is safe to re-run; every step resumes without duplication.

4. **Relay each human action, then re-push.** Push never waits. When it reports a login link or a missing config value, relay it to the user and ask them to complete it in their browser. Never open auth links and never ask for the secret values yourself. After the user confirms, run `two80 push` again to resume.

5. **Verify, then share.** Push exits with the live URL; the edge can lag up to a minute. If it is broken or stale, wait 30 seconds and retry before pushing again. Once the app works, give the user the live link.
