import { identity } from "@two80/sdk";
import { headers } from "next/headers";

export async function visitor() {
  try {
    const viewer = await identity(await headers());
    return {
      available: true as const,
      user: viewer.user,
      role: viewer.role || "none",
      title: viewer.title || "none",
      anonymous: viewer.anonymous,
      canManage: viewer.can("manager"),
      regionScope: viewer.scope("region"),
    };
  } catch (error) {
    return {
      available: false as const,
      message: error instanceof Error ? error.message : "Identity is unavailable",
    };
  }
}
