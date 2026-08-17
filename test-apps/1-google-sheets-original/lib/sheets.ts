import { google } from "googleapis";

export type Todo = { id: string; text: string; done: boolean };

// Data lives on the first sheet, one row per todo: [id, text, done].
const RANGE = "A:C";

const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

function client() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      // Env vars store newlines escaped; restore them for the PEM key.
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function firstSheetId(sheets: ReturnType<typeof client>): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return meta.data.sheets![0].properties!.sheetId!;
}

export async function getTodos(): Promise<Todo[]> {
  const sheets = client();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: RANGE });
  const rows = res.data.values ?? [];
  return rows.map((r) => ({ id: r[0], text: r[1], done: r[2] === "TRUE" }));
}

export async function addTodo(text: string): Promise<void> {
  const sheets = client();
  const id = Date.now().toString();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: RANGE,
    valueInputOption: "RAW",
    requestBody: { values: [[id, text, "FALSE"]] },
  });
}

// Returns the 0-based row index of the todo, or -1 if not found.
async function rowIndexOf(sheets: ReturnType<typeof client>, id: string): Promise<number> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "A:A" });
  return (res.data.values ?? []).findIndex((r) => r[0] === id);
}

export async function toggleTodo(id: string, done: boolean): Promise<void> {
  const sheets = client();
  const i = await rowIndexOf(sheets, id);
  if (i < 0) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `C${i + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[done ? "TRUE" : "FALSE"]] },
  });
}

export async function deleteTodo(id: string): Promise<void> {
  const sheets = client();
  const i = await rowIndexOf(sheets, id);
  if (i < 0) return;
  const sheetId = await firstSheetId(sheets);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 },
          },
        },
      ],
    },
  });
}
