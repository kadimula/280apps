import { headers } from "next/headers";
import { googleSheets, type GoogleSheetsClient } from "@two80/sdk";

export type Todo = { id: string; text: string; done: boolean };

// The 280.json alias the platform binds to a connected spreadsheet.
const RESOURCE = "todos";
// Data lives on the first sheet, one row per todo: [id, text, done].
const RANGE = "A:C";

async function client(): Promise<GoogleSheetsClient> {
  return googleSheets(await headers());
}

export async function getTodos(): Promise<Todo[]> {
  const sheets = await client();
  const res = await sheets.read({ resource: RESOURCE, range: RANGE });
  return (res.values ?? []).map((r) => ({ id: String(r[0]), text: String(r[1]), done: r[2] === "TRUE" }));
}

export async function addTodo(text: string): Promise<void> {
  const sheets = await client();
  const id = Date.now().toString();
  await sheets.append({ resource: RESOURCE, range: RANGE, values: [[id, text, "FALSE"]] });
}

// Returns the 0-based row index of the todo, or -1 if not found.
async function rowIndexOf(sheets: GoogleSheetsClient, id: string): Promise<number> {
  const res = await sheets.read({ resource: RESOURCE, range: "A:A" });
  return (res.values ?? []).findIndex((r) => r[0] === id);
}

export async function toggleTodo(id: string, done: boolean): Promise<void> {
  const sheets = await client();
  const i = await rowIndexOf(sheets, id);
  if (i < 0) return;
  await sheets.update({ resource: RESOURCE, range: `C${i + 1}`, values: [[done ? "TRUE" : "FALSE"]] });
}

export async function deleteTodo(id: string): Promise<void> {
  const sheets = await client();
  const i = await rowIndexOf(sheets, id);
  if (i < 0) return;
  await sheets.deleteRows({ resource: RESOURCE, startRow: i + 1, rowCount: 1 });
}
