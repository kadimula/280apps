# Sheets Todo

A minimal Next.js todo app that uses a Google Sheet as its database, running on [280](https://www.280apps.com).

## How it works

The first tab of your spreadsheet stores one todo per row: `id | text | done`.
Server actions read and write it through `@two80/sdk`'s request-scoped `googleSheets` client.
The app holds no Google credentials and no spreadsheet id: it names the alias `todos` in
`280.json`, and 280 authorizes every call for the current app and user. Identity and access
are handled by the platform gateway; the app writes no auth.

## Setup

1. **Push the app.**

   ```bash
   npx -y two80@latest push
   ```

2. **Connect Google.** In the 280 dashboard, connect the `todos` integration to a Google
   Sheet you own (a spreadsheet whose first tab has no header row). Activation parks until
   the alias is bound, then resumes automatically.

That's it. No service account, no keys, no env vars.
