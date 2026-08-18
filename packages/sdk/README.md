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

`identity(request)` never throws when no identity header is present: it resolves to a safe absent viewer with `present: false`, empty `user`/`role`/`title`, and `can()`/`scope()` returning `false`/`null`. Branch on `present` instead of wrapping the call in `try`/`catch`:

```ts
const viewer = await identity(request);
if (!viewer.present) return <SignInPrompt />;
```

A malformed token is a genuine failure (the gateway signs valid tokens and is the container's only ingress) and still throws `IdentityError`. The token is not re-verified here; the gateway already verified it.

Before writes or per-user rows in a public app, branch on `anonymous`:

```ts
if (identity.anonymous) return new Response("Sign in required", { status: 401 });
```

## Integrations

Each integration is a factory that takes the incoming request (same shapes as `identity`: a Fetch `Request` or `await headers()`) and returns a typed client. The 280 API authorizes every call for the current app and user; your app never sees provider credentials.

### Not-ready vs. genuine failure

The platform has expected *not-ready* states where a human still needs to act: the integration is **not connected** yet, the bound resource was **removed**, or the owner must **re-authorize**. On these, calls do **not** throw. They resolve to a safe result carrying an optional `notReady` code, so an app that just renders the data shows an empty state instead of crashing:

```ts
const { values, notReady } = await sheets.read({ resource, range });
values.map(...);          // [] when not-ready — renders "nothing yet"
if (notReady) { /* optionally prompt the owner to connect Google */ }
```

Writes (`append`/`update`/`deleteRows`) return the same-shaped result with zeroed counts and `notReady` set; they never throw on a not-ready integration. `notReady` is one of `not_connected`, `resource_not_found`, or `reauthorization_required`.

Every **genuine** failure still throws `IntegrationRequestError` with `{ code, message, status, retryable }`: `provider_error` (502), `provider_unavailable` (503, retryable), `invalid_request` (400), `unauthenticated` (401), `internal_error` (500).

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
