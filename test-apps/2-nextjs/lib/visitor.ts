import { headers } from "next/headers";
import { identity } from "@two80/sdk";

// The gateway verifies the caller and stamps identity before this app runs.
// @two80/sdk decodes that identity; the app writes no auth.
export async function visitor() {
  const { user, can, scope } = await identity(await headers());
  return { email: user.email, name: user.name, tenant: user.tenant, can, scope };
}
