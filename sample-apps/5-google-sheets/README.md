# Sheets Todo

A minimal Next.js todo app that uses a Google Sheet as its database.

## How it works

The first tab of your spreadsheet stores one todo per row: `id | text | done`.
Server actions read and write it through the Google Sheets API using a service account.

## Setup

1. **Create the spreadsheet.** New Google Sheet. Leave the first tab empty (no header row).
   Copy its ID from the URL: `docs.google.com/spreadsheets/d/`**`<THIS>`**`/edit`.

2. **Create a service account.**
   - Go to [console.cloud.google.com](https://console.cloud.google.com), create/pick a project.
   - Enable the **Google Sheets API**.
   - APIs & Services → Credentials → Create credentials → Service account.
   - Open the service account → Keys → Add key → JSON. Download it.

3. **Share the sheet** with the service account's email (the `client_email` in the JSON),
   giving it **Editor** access.

4. **Configure env.** Copy `.env.local.example` to `.env.local` and fill in:
   - `GOOGLE_SHEET_ID` — the ID from step 1.
   - `GOOGLE_CLIENT_EMAIL` — `client_email` from the JSON.
   - `GOOGLE_PRIVATE_KEY` — `private_key` from the JSON, kept as one line with `\n` escapes
     and wrapped in double quotes (as shown in the example).

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000.
