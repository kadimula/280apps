// The gateway's own HTML surfaces, rendered inline so a control-plane outage
// can't turn the front door into a timeout.

// Card + tokens mirror the dashboard's sign-in surface (packages/dashboard). The
// values are inlined rather than shared because the gateway renders self-contained
// HTML with no build step or external fonts, so a control-plane outage can't stall
// the front door. Georgia stands in for the dashboard's Oranienbaum display face.
const STYLE = `
  body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#0a0a0a;margin:0;
       min-height:100svh;padding:2rem;display:grid;place-content:center;
       background:radial-gradient(120% 80% at 50% 0%,rgba(212,175,55,.11),rgba(212,175,55,0) 60%),#faf8f3}
  .card{width:100%;max-width:24rem;box-sizing:border-box;text-align:center;background:#fff;
        border:1px solid #e9e5da;border-radius:1rem;padding:2.5rem 2rem;
        box-shadow:0 1px 2px rgba(10,10,10,.04)}
  h1{font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:2rem;line-height:1.15;
     margin:0;color:#0a0a0a}
  p{color:#56534c;font-size:14px;margin:.75rem 0 0}
  .providers{margin-top:1.75rem;display:flex;flex-direction:column;gap:.5rem}
  a.btn{display:flex;align-items:center;justify-content:center;gap:.75rem;padding:.75rem 1rem;
        border:1px solid #d7d1c1;border-radius:.5rem;background:#fff;color:#0a0a0a;text-decoration:none;
        font-size:14px;font-weight:500;transition:background-color .15s}
  a.btn:hover{background:#faf8f3}
  a.btn svg{width:18px;height:18px;flex:none}
  @media (prefers-color-scheme:dark){
    body{color:#f4f2ec;background:#050505}
    .card{background:#050505;border-color:#222}
    h1{color:#f4f2ec}p{color:#c6c3ba}
    a.btn{background:#050505;border-color:#333;color:#f4f2ec}
    a.btn:hover{background:#0e0e0e}}
`;

// Brand marks for the sign-in buttons, keyed by provider name. Static, trusted SVG
// (no user input), so it is inlined into the button without escaping.
const PROVIDER_ICONS: Record<string, string> = {
  google: `<svg viewBox="0 0 24 24" aria-hidden><path fill="#4285F4" d="M23.52 12.27c0-.82-.07-1.6-.21-2.36H12v4.46h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.72Z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.28a12 12 0 0 0 0 10.77l4.01-3.11Z"/><path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.58 1.79l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.28 6.62l4.01 3.1C6.23 6.87 8.88 4.75 12 4.75Z"/></svg>`,
  microsoft: `<svg viewBox="0 0 24 24" aria-hidden><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>`,
};

export interface ProviderLink {
  name: string;
  label: string;
}

export function loginPage(providers: ProviderLink[], redirect: string): string {
  const q = redirect === '' ? '' : `?redirect=${encodeURIComponent(redirect)}`;
  const buttons = providers
    .map((p) => {
      const icon = PROVIDER_ICONS[p.name] ?? '';
      return `<a class="btn" href="/auth/${encodeURIComponent(p.name)}/start${q}">${icon}${escapeHtml(p.label)}</a>`;
    })
    .join('\n      ');
  return page(
    'Sign in',
    `<h1>Sign in</h1>\n    <p>Sign in to continue to this app.</p>\n    <div class="providers">\n      ${buttons}\n    </div>`,
  );
}

export function denyPage(reason: string): string {
  return page('No access', `<h1>You don't have access</h1>\n    <p>${escapeHtml(reason)}</p>`);
}

export function errorPage(): string {
  return page('Something went wrong', `<h1>Something went wrong</h1><p>Please try again.</p>`);
}

// Shown when the app Worker cannot reach the central gateway to mint or refresh an
// identity and holds no still-valid token: sign-in is down, not the app. A retry
// once the gateway recovers (or a live token) serves normally.
export function unavailablePage(): string {
  return page('Sign-in unavailable', `<h1>Sign-in is temporarily unavailable</h1><p>Please retry in a moment.</p>`);
}

function page(title: string, inner: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<div class="card">
    ${inner}
</div>
`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
