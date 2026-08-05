import { cookies } from "next/headers";

import { MockAuthToggle } from "@/components/mock-auth-toggle";
import { MOCK_BACKEND } from "@/lib/api";
import { MOCK_AUTH_COOKIE } from "@/lib/mock-backend";

// The floating mock-auth toggle, wired to the cookie the mock reads. It gates
// itself on MOCK_BACKEND, so off the mock (every real deploy) it renders nothing
// and the layout can drop it in unconditionally. It sits fixed in the corner
// rather than in a page's header so it stays reachable when signed out, which is
// exactly when a header with a user menu would be gone.
export async function MockAuthControl() {
  if (!MOCK_BACKEND) return null;
  const signedIn = (await cookies()).get(MOCK_AUTH_COOKIE)?.value !== "out";

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <MockAuthToggle signedIn={signedIn} />
    </div>
  );
}
