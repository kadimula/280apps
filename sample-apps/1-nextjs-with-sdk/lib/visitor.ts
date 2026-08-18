import { identity } from "@two80/sdk";
import { headers } from "next/headers";

export async function visitor() {
  const viewer = await identity(await headers());
  if (!viewer.present) return { available: false as const };
  return {
    available: true as const,
    user: viewer.user,
    role: viewer.role || "none",
    title: viewer.title || "none",
    anonymous: viewer.anonymous,
    canManage: viewer.can("manager"),
    regionScope: viewer.scope("region"),
  };
}
