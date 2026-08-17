# @two80/sdk

The only identity and platform-access code a [280](https://www.280apps.com) app ever contains. Your app holds no auth, no sessions, no provider credentials, and no user table. The 280 gateway authenticates the caller, gates the route, and forwards one short-lived signed identity header; this SDK decodes it and gives you a typed client for each platform capability.

    npm install @two80/sdk

The SDK reads the platform-supplied `TWO80_API` origin from the environment. Never override it. The container reaches only the 280 API host; the API authorizes every call for the current app and user.

## Request scoping

Everything is request-scoped: pass the incoming request so the SDK forwards the caller's identity. Nothing is global or cached across requests. "The request" is anything that exposes its headers: a Fetch `Request` (`identity(request)`) or Next's `headers()` result (`identity(await headers())`).

```ts
import { identity } from "@two80/sdk";

// Next.js route handler, Server Action, or any handler with the request in scope.
export async function GET(request: Request) {
  const { user, can, scope, role, anonymous } = await identity(request);

  user.email;             // resolved by the gateway, never by app code
  can("approvals.edit");  // true when the viewer holds that feature role
  scope("salaries");      // advisory data scope, or null
  role;                   // '' | owner | admin | editor | viewer
  anonymous;              // true for a public app's no-session visitor
}
```

`identity(request)` throws `IdentityError` when no identity header is present: treat that as an unauthenticated caller. The token is not re-verified here; the gateway is the container's only ingress and already verified it.

Before writes or per-user rows in a public app, branch on `anonymous`:

```ts
if (identity.anonymous) return new Response("Sign in required", { status: 401 });
```

## Integrations

Each integration is a factory that takes the incoming request (same shapes as `identity`: a Fetch `Request` or `await headers()`) and returns a typed client. The 280 API authorizes every call for the current app and user; your app never sees provider credentials. A failed call throws `IntegrationRequestError` with `{ code, message, status, retryable }`.

Declare each integration the app uses in `280.json` so `push` gates the deploy until the owner connects it:

```json
{ "integrations": ["google-sheets"] }
```

### Google Sheets — `googleSheets(request)`

```ts
import { googleSheets } from "@two80/sdk";

const sheets = googleSheets(request);
await sheets.read({ resource, range });            // -> { range, majorDimension, values }
await sheets.append({ resource, range, values });  // -> { updatedRange, updatedRows, updatedCells }
await sheets.update({ resource, range, values });  // -> { updatedRange, updatedRows, updatedCells }
```

`resource` is the spreadsheet id, `range` is A1 notation (e.g. `Sheet1!A1:C10`), and `values` is a 2D array of cell values.

## Capability reference

The authoritative list of supported capabilities and operations, generated from the 280 capability catalog, lives at <https://www.280apps.com/capabilities.md>. If an operation you need is not listed, it is unsupported: report it rather than working around the network boundary.
