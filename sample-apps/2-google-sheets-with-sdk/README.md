# Google Sheets To-Dos (280 SDK)

A minimal Next.js todo app that stores its data in a Google Sheet, reached entirely
through `@two80/sdk`. The app holds **no** provider credentials and never touches the
Google API directly: 280 authorizes each call for the current app and user.

## How it works

The first tab of a spreadsheet stores one todo per row: `id | text | done`.
Server actions read and write it through the request-scoped `googleSheets(...)` client:

```ts
import { googleSheets } from "@two80/sdk";
import { headers } from "next/headers";

const sheets = googleSheets(await headers());
await sheets.read({ resource: "todos", range: "A:C" });
await sheets.append({ resource: "todos", range: "A:C", values: [[id, text, "FALSE"]] });
await sheets.update({ resource: "todos", range: "C5", values: [["TRUE"]] });
await sheets.deleteRows({ resource: "todos", startRow: 5, rowCount: 1 });
```

`resource` is the alias `todos` declared in `280.json`, not a spreadsheet id. 280 binds
that alias to a real sheet when you connect Google in the dashboard. The app carries no
sheet id, no service account, and no key.

## Requirement declaration

`280.json` declares the one integration this app needs:

```json
{
  "integrations": {
    "todos": {
      "capability": "google-sheets",
      "operations": ["read", "append", "update", "deleteRows"]
    }
  }
}
```

Push parks the deploy until the `todos` alias is bound to a connected Google Sheet.

## Deploy

1. **Push.** From this directory, run `npx -y two80@latest push`.
2. **Connect Google.** In the 280 dashboard, open the app, connect Google, and bind the
   `todos` alias to your spreadsheet (first tab empty, no header row).
3. **Done.** The parked deploy resumes automatically once the alias is bound. Open the
   app's 280 URL.

No `.env`, no credentials, no console.cloud.google.com setup.
