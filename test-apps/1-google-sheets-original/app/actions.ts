"use server";

import { revalidatePath } from "next/cache";
import { addTodo, toggleTodo, deleteTodo } from "@/lib/sheets";

export async function createAction(formData: FormData) {
  const text = String(formData.get("text") ?? "").trim();
  if (text) await addTodo(text);
  revalidatePath("/");
}

export async function toggleAction(formData: FormData) {
  await toggleTodo(String(formData.get("id")), formData.get("done") === "true");
  revalidatePath("/");
}

export async function deleteAction(formData: FormData) {
  await deleteTodo(String(formData.get("id")));
  revalidatePath("/");
}
