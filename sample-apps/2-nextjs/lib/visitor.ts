import { headers } from "next/headers";
import { identity } from "@280/sdk";

// The only identity code a 280 app ever contains. The gateway verifies the caller
// and forwards a signed header; @280/sdk verifies it offline and returns the user,
// a can() capability check, and a scope() resolver. The app writes no auth.
export async function visitor() {
  const { user, can, scope } = await identity(await headers());
  return { email: user.email, name: user.name, tenant: user.tenant, can, scope };
}
