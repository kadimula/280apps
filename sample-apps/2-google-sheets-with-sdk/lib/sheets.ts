import { googleSheets, type GoogleSheetsClient } from "@two80/sdk";
import { headers } from "next/headers";

export type Todo = { id: string; text: string; done: boolean };

// The render path degrades gracefully: until the `todos` alias is bound to a real
// sheet in the 280 dashboard, the SDK read throws and the page shows a connect state
// instead of a 500. Mirrors 1-nextjs-with-sdk/lib/visitor.ts.
export type TodosResult = { available: true; todos: Todo[] } | { available: false; message: string };

// The app names a stable alias declared in 280.json; 280 binds it to a real sheet.
const RESOURCE = "todos";
// Data lives on the first sheet, one row per todo: [id, text, done].
const RANGE = "A:C";

async function sheets(): Promise<GoogleSheetsClient> {
  return googleSheets(await headers());
}

export async function getTodos(): Promise<TodosResult> {
  try {
    const res = await (await sheets()).read({ resource: RESOURCE, range: RANGE });
    const todos = res.values.map((r) => ({ id: String(r[0]), text: String(r[1] ?? ""), done: r[2] === "TRUE" }));
    return { available: true, todos };
  } catch (error) {
    return { available: false, message: error instanceof Error ? error.message : "Google Sheets is unavailable" };
  }
}

export async function addTodo(text: string): Promise<void> {
  const id = Date.now().toString();
  await (await sheets()).append({ resource: RESOURCE, range: RANGE, values: [[id, text, "FALSE"]] });
}

// Returns the one-based row number of the todo, or -1 if not found.
async function rowNumberOf(client: GoogleSheetsClient, id: string): Promise<number> {
  const res = await client.read({ resource: RESOURCE, range: "A:A" });
  const i = res.values.findIndex((r) => String(r[0]) === id);
  return i < 0 ? -1 : i + 1;
}

export async function toggleTodo(id: string, done: boolean): Promise<void> {
  const client = await sheets();
  const row = await rowNumberOf(client, id);
  if (row < 0) return;
  await client.update({ resource: RESOURCE, range: `C${row}`, values: [[done ? "TRUE" : "FALSE"]] });
}

export async function deleteTodo(id: string): Promise<void> {
  const client = await sheets();
  const row = await rowNumberOf(client, id);
  if (row < 0) return;
  await client.deleteRows({ resource: RESOURCE, startRow: row, rowCount: 1 });
}
