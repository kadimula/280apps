// The mock backend's stand-in for the gateway's /__280/preview bootstrap page.
// When MOCK_BACKEND is on, the preview-grant mock points the dashboard iframe
// here instead of at a real app host, so the embedded preview and the "View as"
// identity switch can be seen working with no platform reachable. It echoes the
// identity the grant was minted for, which is exactly what a person iterating on
// the dropdown needs to see change.
//
// A development aid, never shipped behavior: production 404s unconditionally,
// the same gate the mock router itself lives behind.

export function GET(request: Request): Response {
  if (process.env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const slug = params.get("slug") ?? "app";
  const host = params.get("host") ?? "";
  const who = params.get("who") ?? "you";

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(slug)} (mock preview)</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
    background: #fdfcfa; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #161513; color: #ece9e2; }
    .card { border-color: #3a382f; }
    .muted { color: #a09a8c; }
  }
  .card {
    border: 1px solid #e4e0d5; border-radius: 16px; padding: 40px 48px;
    text-align: center; max-width: 420px;
  }
  h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }
  .muted { color: #75705f; font-size: 13px; margin: 0; }
  .who {
    display: inline-block; margin-top: 18px; padding: 6px 14px;
    border-radius: 999px; background: #c9a2271f; border: 1px solid #c9a22755;
    font-family: ui-monospace, monospace; font-size: 13px;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${esc(slug)}</h1>
    <p class="muted">Mock bootstrap page standing in for https://${esc(host)}/__280/preview</p>
    <span class="who">signed in as ${esc(who)}</span>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
