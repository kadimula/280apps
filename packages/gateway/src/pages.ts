// The gateway's own HTML surfaces, rendered inline so a control-plane outage
// can't turn the front door into a timeout.

const STYLE = `
  body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;color:#111;background:#fff;
       display:grid;place-content:center;min-height:100svh;margin:0;padding:2rem;text-align:center}
  .card{max-width:22rem}
  h1{font-size:1.4rem;margin:0 0 .25rem}
  p{color:#555;margin:.25rem 0 1.5rem}
  a.btn{display:block;margin:.5rem 0;padding:.7rem 1rem;border:1px solid #ddd;border-radius:.6rem;
        color:inherit;text-decoration:none;font-weight:600}
  a.btn:hover{border-color:#aaa}
  @media (prefers-color-scheme:dark){body{color:#eee;background:#111}p{color:#aaa}
    a.btn{border-color:#333}a.btn:hover{border-color:#666}}
`;

export interface ProviderLink {
  name: string;
  label: string;
}

export function loginPage(providers: ProviderLink[], redirect: string): string {
  const q = redirect === '' ? '' : `?redirect=${encodeURIComponent(redirect)}`;
  const buttons = providers
    .map((p) => `<a class="btn" href="/auth/${encodeURIComponent(p.name)}/start${q}">${escapeHtml(p.label)}</a>`)
    .join('\n    ');
  return page('Sign in', `<h1>Sign in</h1>\n    <p>Sign in to continue to this app.</p>\n    ${buttons}`);
}

export function denyPage(reason: string): string {
  return page('No access', `<h1>You don't have access</h1>\n    <p>${escapeHtml(reason)}</p>`);
}

export function errorPage(): string {
  return page('Something went wrong', `<h1>Something went wrong</h1><p>Please try again.</p>`);
}

// Shown when the app Worker cannot reach the gateway and holds no valid token:
// sign-in is down, not the app.
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
