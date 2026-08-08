// The app calls the Sheets REST API directly with no auth wiring: 280 attaches the
// service-account OAuth token at the egress boundary (280.json google-service-account
// credential), so no Authorization header, no SDK, no key ever enters this code.
// GOOGLE_SHEET_ID is config the app reads (280.json config → process.env).

export type Todo = { id: string; text: string; done: boolean };

// Data lives on the first sheet, one row per todo: [id, text, done].
const RANGE = "A:C";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

const sheetId = process.env.GOOGLE_SHEET_ID!;

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API}/${sheetId}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`sheets ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function firstSheetId(): Promise<number> {
  const meta = (await api("?fields=sheets.properties.sheetId")) as {
    sheets?: { properties?: { sheetId?: number } }[];
  };
  return meta.sheets?.[0]?.properties?.sheetId ?? 0;
}

export async function getTodos(): Promise<Todo[]> {
  const res = (await api(`/values/${RANGE}`)) as { values?: string[][] };
  return (res.values ?? []).map((r) => ({ id: r[0], text: r[1], done: r[2] === "TRUE" }));
}

export async function addTodo(text: string): Promise<void> {
  const id = Date.now().toString();
  await api(`/values/${RANGE}:append?valueInputOption=RAW`, {
    method: "POST",
    body: JSON.stringify({ values: [[id, text, "FALSE"]] }),
  });
}

// Returns the 0-based row index of the todo, or -1 if not found.
async function rowIndexOf(id: string): Promise<number> {
  const res = (await api("/values/A:A")) as { values?: string[][] };
  return (res.values ?? []).findIndex((r) => r[0] === id);
}

export async function toggleTodo(id: string, done: boolean): Promise<void> {
  const i = await rowIndexOf(id);
  if (i < 0) return;
  await api(`/values/C${i + 1}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [[done ? "TRUE" : "FALSE"]] }),
  });
}

export async function deleteTodo(id: string): Promise<void> {
  const i = await rowIndexOf(id);
  if (i < 0) return;
  const sheet = await firstSheetId();
  await api(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [
        { deleteDimension: { range: { sheetId: sheet, dimension: "ROWS", startIndex: i, endIndex: i + 1 } } },
      ],
    }),
  });
}
