import { visitor } from "@/lib/visitor";

function scopeLabel(scope: unknown) {
  if (scope === null) return "Not assigned";
  if (typeof scope === "string") return scope;
  return JSON.stringify(scope);
}

export default async function HomePage() {
  const viewer = await visitor();

  if (!viewer.available) {
    return (
      <main className="shell">
        <section className="card missing">
          <div className="eyebrow">280 SDK sample</div>
          <h1>Identity is waiting at the gateway.</h1>
          <p>Open the deployed 280 URL to receive a verified platform identity.</p>
          <code>{viewer.message}</code>
        </section>
      </main>
    );
  }

  const displayName = viewer.anonymous ? "Anonymous visitor" : viewer.user.name || viewer.user.email;

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <div className="eyebrow">280 SDK sample</div>
          <h1>Identity without application auth.</h1>
          <p>The gateway resolved this viewer before the request reached Next.js.</p>
        </div>
        <span className={viewer.anonymous ? "status anonymous" : "status"}>
          <i /> {viewer.anonymous ? "Anonymous" : "Verified"}
        </span>
      </section>

      <section className="identity card">
        <div className="avatar">{displayName.slice(0, 1).toUpperCase()}</div>
        <div>
          <span className="label">Current viewer</span>
          <h2>{displayName}</h2>
          <p>{viewer.user.email || "No email for anonymous viewers"}</p>
        </div>
      </section>

      <section className="grid">
        <article className="card metric">
          <span className="label">Tenant</span>
          <strong>{viewer.user.tenant || "Public"}</strong>
        </article>
        <article className="card metric">
          <span className="label">App role</span>
          <strong>{viewer.appRole}</strong>
        </article>
        <article className="card metric">
          <span className="label">Feature role</span>
          <strong>{viewer.featureRole}</strong>
        </article>
      </section>

      <section className="grid two">
        <article className="card permission">
          <div>
            <span className="label">can(&quot;manager&quot;)</span>
            <h3>Management capability</h3>
          </div>
          <span className={viewer.canManage ? "pill yes" : "pill no"}>{viewer.canManage ? "Allowed" : "Denied"}</span>
        </article>
        <article className="card permission">
          <div>
            <span className="label">scope(&quot;region&quot;)</span>
            <h3>Advisory data scope</h3>
          </div>
          <span className="scope">{scopeLabel(viewer.regionScope)}</span>
        </article>
      </section>

      <footer>
        Read on the server with <code>identity(await headers())</code>
      </footer>
    </main>
  );
}
