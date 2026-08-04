import { redirect } from "next/navigation";

// The dashboard is the app's home. /dashboard resolves identity and sends a
// signed-out visitor on to /login, so the root only needs to point there.
export default function Home() {
  redirect("/dashboard");
}
