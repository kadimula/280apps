280apps.com securely deploys internal tools built by agents. Three tenets: application code never sees provider credentials, the agent owns deploy and debugging, and the human owns login and access.

Full capability and operation reference: https://www.280apps.com/capabilities.md

## Deploy procedure

1. **Audit against the capability reference.** Check the app against https://www.280apps.com/capabilities.md. If any required operation is unsupported, stop and report it; do not work around the network boundary.

2. **Route external access through `@two80/sdk`.** The container reaches only the 280 API. Run `npm install @two80/sdk`, replace every provider SDK, raw API call, and connection string with the matching SDK capability, and remove all API keys, tokens, service-account files, and authorization headers from the app. Never override `TWO80_API`. Declare each capability the app uses in `280.json`:

        { "integrations": ["google-sheets"] }

3. **Declare non-credential config only.** Ids, regions, and flags go in the `280.json` config block and reach `process.env`. Credentials never do.

4. **Push.**

        npx -y two80@latest push

   This auto-initializes new projects and is safe to re-run; every step resumes without duplication.

5. **Relay each human action, then re-push.** Push never waits. When it reports a login link, missing config values, or an unconnected integration, relay the link to the user and ask them to complete it in their browser. Never open auth links, never ask for the values yourself, and never authorize integrations yourself. After the user confirms, run `two80 push` again to resume.

6. **Verify, then share.** Push exits with the live URL; the edge can lag up to a minute. If it is broken or stale, wait 30 seconds and retry before pushing again. Once the workflows work, give the user the live link.
