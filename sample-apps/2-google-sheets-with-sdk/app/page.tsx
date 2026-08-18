import { getTodos } from "@/lib/sheets";
import { createAction, toggleAction, deleteAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function Home() {
  const result = await getTodos();

  if (!result.available) {
    return (
      <main>
        <h1>Google Sheets To-Dos</h1>
        <section style={{ background: "#0f2a5a", borderRadius: 8, padding: 16 }}>
          <p style={{ margin: "0 0 8px" }}>
            Connect the <strong>todos</strong> Google Sheet in the 280 dashboard to start adding to-dos.
          </p>
          <code style={{ fontSize: 12, color: "#9fb3d9", wordBreak: "break-word" }}>{result.message}</code>
        </section>
      </main>
    );
  }

  const todos = result.todos;

  return (
    <main>
      <h1>Google Sheets To-Dos</h1>

      <form action={createAction} style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          name="text"
          placeholder="What needs doing?"
          autoComplete="off"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" style={{ padding: "8px 16px" }}>
          Add
        </button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        {todos.map((t) => (
          <li key={t.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <form action={toggleAction}>
              <input type="hidden" name="id" value={t.id} />
              <input type="hidden" name="done" value={(!t.done).toString()} />
              <button
                type="submit"
                aria-label={t.done ? "Mark as not done" : "Mark as done"}
                style={{ cursor: "pointer" }}
              >
                {t.done ? "☑" : "☐"}
              </button>
            </form>

            <span
              style={{
                flex: 1,
                textDecoration: t.done ? "line-through" : "none",
                color: t.done ? "#888" : "inherit",
              }}
            >
              {t.text}
            </span>

            <form action={deleteAction}>
              <input type="hidden" name="id" value={t.id} />
              <button type="submit" aria-label="Delete" style={{ cursor: "pointer" }}>
                ✕
              </button>
            </form>
          </li>
        ))}
        {todos.length === 0 && <li style={{ color: "#888" }}>Nothing yet.</li>}
      </ul>
    </main>
  );
}
