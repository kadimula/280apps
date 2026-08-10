import { visitor } from "@/lib/visitor";

// Server component by default. Identity comes from the request headers 280
// injects at the edge, never from a login page inside the app.
export default async function HomePage() {
  const { name, email } = await visitor();
  const who = email === "anonymous" || email === "" ? "Guest" : name || email;

  return (
    <main>
      <span className="badge">Sample App 3</span>
      <h1>Hello from 280</h1>
      <p>This is a Next.js App Router app.</p>
      <p>
        Signed in as <strong>{who}</strong>.
      </p>
      <p>
        Deployed with <code>two80 push</code>.
      </p>
    </main>
  );
}
