import { headers } from "next/headers";

// The only identity code a 280 app ever contains. 280 injects signed headers at
// the edge; the app never writes auth. Link visitors arrive as "anonymous".
export type Role = "editor" | "reader";

export async function visitor() {
  const h = await headers();

  const roles: Record<string, Role> = {};
  for (const pair of (h.get("x-280-roles") ?? "").split(";")) {
    const [feature, role] = pair.trim().split("=");
    if (feature && role) roles[feature] = role as Role;
  }

  const actions: Record<string, string[]> = {};
  for (const pair of (h.get("x-280-actions") ?? "").split(";")) {
    const [feature, list] = pair.trim().split("=");
    if (feature && list) actions[feature] = list.split(",");
  }

  return {
    email: h.get("x-280-user") ?? "", // "anonymous" for link visitors (GET only)
    name: h.get("x-280-name") ?? "",
    roles,
    actions,
  };
}
