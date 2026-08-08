# Sheets Todo

A minimal Next.js todo app that uses a Google Sheet as its database.

The first tab of your spreadsheet stores one todo per row: `id | text | done`.
Server actions read and write it by calling the Sheets REST API directly — no SDK, no
credentials in the app. It splits cleanly along the 280 read-test:

- **`GOOGLE_SA_JSON`** (secret) — the service-account JSON. The app never reads it; 280
  mints a scoped OAuth token from it and attaches it at the egress boundary. Declared in
  `280.json` `egress.credentials` (which also allowlists `sheets.googleapis.com`).
- **`GOOGLE_SHEET_ID`** (config) — the app *reads* it to build the request URL, so it is
  config, not a secret. Declared in `280.json` `config`; 280 sets it as `process.env`.

## Setup

1. **Create the spreadsheet.** New Google Sheet. Leave the first tab empty (no header row).
   Copy its ID from the URL: `docs.google.com/spreadsheets/d/`**`<THIS>`**`/edit`, and set it
   as `GOOGLE_SHEET_ID` in `280.json` `config` (or mark it `{ "sensitive": true }` to enter
   it in the dashboard instead).

2. **Create a service account.**
   - Go to [console.cloud.google.com](https://console.cloud.google.com), create/pick a project.
   - Enable the **Google Sheets API**.
   - APIs & Services → Credentials → Create credentials → Service account.
   - Open the service account → Keys → Add key → JSON. Download it.

3. **Share the sheet** with the service account's email (the `client_email` in the JSON),
   giving it **Editor** access.

4. **Push and enter the secret.** Run `npx -y two80@latest push`, then paste the downloaded
   JSON as the `GOOGLE_SA_JSON` value in the 280 dashboard. 280 attaches it at egress; the
   app itself never sees it.
