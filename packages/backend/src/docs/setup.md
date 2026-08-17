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

The container has a fixed network boundary: it reaches the 280 API and no other host. Get database, file, integration, and config access through the SDK instead of external providers or app-managed credentials.

    npm install @two80/sdk

The SDK reads the platform supplied `TWO80_API` origin; never override that environment variable. Remove API keys, access tokens, service account files, connection strings, provider SDK authentication, and code that builds authorization headers from the app. Do not call provider APIs directly. If a required capability is missing from `@two80/sdk`, report it as unsupported rather than weakening the network boundary.

The SDK is an application API, not the security boundary. Cloudflare enforces the one host network rule, and the 280 API authorizes every operation for the current app and user.

### Integrations

Each integration is a factory that takes the incoming request and returns a typed client. Pass the request so the SDK forwards the caller's identity; the 280 API authorizes every call for the current app and user. A failed call throws `IntegrationRequestError` with `{ code, message, status, retryable }`.

**Google Sheets** — `googleSheets(request)`

    import { googleSheets } from "@two80/sdk";

    const sheets = googleSheets(request);
    await sheets.read({ resource, range });            // -> { range, majorDimension, values }
    await sheets.append({ resource, range, values });  // -> { updatedRange, updatedRows, updatedCells }
    await sheets.update({ resource, range, values });  // -> { updatedRange, updatedRows, updatedCells }

`resource` is the spreadsheet id, `range` is A1 notation (e.g. `Sheet1!A1:C10`), and `values` is a 2D array of cell values.

Declare every integration the app uses in `280.json` so push can gate the deploy until it is connected:

    { "integrations": ["google-sheets"] }

## 3. Install the CLI and push

    npx -y two80@latest push

This initializes new projects automatically. It is safe to run again because every step resumes without duplication.

## 4. Login in the user's browser

When push prints a login link, relay it and wait. Never open it yourself.

> Log in to 280 to deploy: <url>

After the user confirms, push again.

## 5. Config values in the user's browser

When push exits reporting missing values, relay the link and ask the user to enter them. Never ask for the values yourself.

Push does not wait. Once the user confirms that values are saved, run `two80 push` again to resume.

## 6. Connect integrations in the user's browser

When push exits reporting an unconnected integration, relay the link and ask the user to authorize it in the dashboard. The app owner connects each declared integration once; never authorize it yourself.

Push does not wait. Once the user confirms the integration is connected, run `two80 push` again to resume.

## 7. Verify, then hand over the link

Push exits with the live URL. The edge can lag up to a minute.

1. If broken or stale, wait 30 seconds and retry. Do not push again yet.
2. If still broken after two retries, fix it and push again.
3. If clean, give the user the live link.
