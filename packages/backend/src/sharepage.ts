// The share dialog, server-rendered as one self-contained page (no build step, no
// framework) that the control plane serves at /internal/apps/:app/share. It is the
// Google-Docs-style surface the design calls for (§5.4): two sections in one dialog
// — tier 1 App access (owner/admin/editor/viewer) and tier 2 Feature roles — plus a
// "View as" control. It reads and writes through the JSON grant endpoints in api.ts;
// "View as" links out to the gateway, which owns and enforces the preview.

// escapeAttr keeps a value safe inside the single JSON blob and data-* attributes
// the page bootstraps from; the dynamic rows are built by the inlined script from
// that JSON, never by string-concatenating server HTML.
function escapeJson(s: string): string {
  return s
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface ShareBootstrap {
  app: { id: string; slug: string; url: string; script: string };
  access: string;
  roles: string[];
  viewAsOrigin: string;
}

export function sharePage(boot: ShareBootstrap): string {
  const json = escapeJson(JSON.stringify(boot));
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Share ${escapeHtml(boot.app.slug)}</title>
<style>${STYLE}</style>
<div class="wrap">
  <header>
    <h1>Share &ldquo;<span id="app-name"></span>&rdquo;</h1>
    <a id="open-app" class="link" target="_blank" rel="noopener">Open app &nearr;</a>
  </header>

  <section class="surface" aria-labelledby="s1">
    <h2 id="s1">App access</h2>
    <p class="sub">Tier 1 &middot; who can open, edit, and share the app itself.</p>
    <ul id="app-grants" class="rows"></ul>
    <form id="invite" class="invite">
      <input type="email" id="invite-email" placeholder="name@company.com" required>
      <select id="invite-role" aria-label="App role">
        <option value="viewer">Viewer</option>
        <option value="editor">Editor</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </select>
      <button type="submit">Invite</button>
    </form>
  </section>

  <section class="surface" aria-labelledby="s2">
    <h2 id="s2">Feature roles</h2>
    <p class="sub">Tier 2 &middot; what each person can see and do inside the app. Roles are defined in 280.json.</p>
    <div id="no-roles" class="empty" hidden>This app declares no feature roles yet.</div>
    <ul id="feature-grants" class="rows"></ul>
    <form id="assign" class="invite">
      <input type="email" id="assign-email" placeholder="name@company.com" required>
      <select id="assign-role" aria-label="Feature role"></select>
      <button type="submit">Assign</button>
    </form>
  </section>

  <p id="status" class="status" role="status"></p>
</div>
<script type="application/json" id="boot">${json}</script>
<script>${SCRIPT}</script>
`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const STYLE = `
  :root{color-scheme:light dark}
  body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;color:#111;background:#f6f7f9;margin:0;padding:2rem}
  .wrap{max-width:34rem;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:.9rem;padding:1.5rem 1.5rem 1.75rem;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:.5rem}
  h1{font-size:1.25rem;margin:0}
  h2{font-size:.95rem;margin:1.4rem 0 .15rem}
  .sub{color:#6b7280;margin:.1rem 0 .7rem;font-size:.85rem}
  .link{color:#2563eb;text-decoration:none;font-size:.85rem;white-space:nowrap}
  .link:hover{text-decoration:underline}
  .rows{list-style:none;margin:0;padding:0}
  .row{display:flex;align-items:center;gap:.6rem;padding:.5rem 0;border-top:1px solid #f0f1f3}
  .row:first-child{border-top:none}
  .avatar{width:2rem;height:2rem;border-radius:50%;background:#e0e7ff;color:#3730a3;display:grid;place-content:center;font-weight:600;font-size:.8rem;flex:0 0 auto}
  .who{flex:1 1 auto;min-width:0}
  .who .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .who .mail{color:#6b7280;font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  select,button,input{font:inherit}
  select,input{padding:.35rem .5rem;border:1px solid #d1d5db;border-radius:.45rem;background:#fff;color:inherit}
  button{padding:.4rem .8rem;border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:.45rem;cursor:pointer;font-weight:600}
  button.ghost{background:#fff;color:#374151;border-color:#d1d5db;font-weight:500}
  button:hover{filter:brightness(1.05)}
  .invite{display:flex;gap:.5rem;margin-top:.7rem}
  .invite input{flex:1 1 auto;min-width:0}
  .viewas{font-size:.8rem;color:#2563eb;text-decoration:none}
  .viewas:hover{text-decoration:underline}
  .empty{color:#6b7280;font-size:.85rem;padding:.4rem 0}
  .status{min-height:1.2rem;color:#6b7280;font-size:.82rem;margin:1rem 0 0}
  .status.err{color:#b91c1c}
  @media (prefers-color-scheme:dark){
    body{color:#e5e7eb;background:#0b0d10}
    .wrap{background:#15181d;border-color:#2a2f37;box-shadow:none}
    .row{border-color:#23272e}.sub,.who .mail,.status,.empty{color:#9aa4b2}
    select,input{background:#0f1216;border-color:#333a44;color:inherit}
    button.ghost{background:#15181d;color:#d1d5db;border-color:#333a44}
    .avatar{background:#26304d;color:#c7d2fe}
  }
`;

// The page's whole behavior: fetch the grant list, render both surfaces, and wire
// role changes / revokes / invites / view-as through the JSON endpoints. Kept tiny
// and dependency-free so it ships inline.
const SCRIPT = `
(function(){
  var boot = JSON.parse(document.getElementById('boot').textContent);
  var base = location.pathname.replace(/\\/share$/, '');
  var APP_ROLES = ['viewer','editor','admin','owner'];
  var statusEl = document.getElementById('status');
  document.getElementById('app-name').textContent = boot.app.slug;
  var openApp = document.getElementById('open-app'); openApp.href = boot.app.url;

  function say(msg, err){ statusEl.textContent = msg; statusEl.className = 'status' + (err ? ' err' : ''); }
  function initials(s){ var p = (s||'').split('@')[0].split(/[.\\-_ ]+/); return ((p[0]||'')[0]||'?').toUpperCase() + ((p[1]||'')[0]||'').toUpperCase(); }
  function label(p){ return p.indexOf('domain:') === 0 ? 'Everyone at ' + p.slice(7) : p; }

  function viewAsUrl(target){
    return boot.viewAsOrigin + '/view-as?app=' + encodeURIComponent(boot.app.script)
      + '&as=' + encodeURIComponent(target) + '&return=' + encodeURIComponent(boot.app.url);
  }

  async function api(path, method, body){
    var res = await fetch(base + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    if(!res.ok){ var t = await res.text(); throw new Error(t || ('HTTP ' + res.status)); }
    return res.status === 204 ? null : res.json();
  }

  function roleSelect(kind, principal, value, options){
    var sel = document.createElement('select');
    options.forEach(function(o){
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o.charAt(0).toUpperCase() + o.slice(1);
      if(o === value) opt.selected = true; sel.appendChild(opt);
    });
    if(kind === 'feature'){ var none = document.createElement('option'); none.value=''; none.textContent='(none)'; if(!value) none.selected = true; sel.insertBefore(none, sel.firstChild); }
    sel.onchange = function(){
      var payload = { principal: principal };
      if(kind === 'app') payload.appRole = sel.value; else { payload.appRole = current.appRole[principal] || 'viewer'; payload.featureRole = sel.value; }
      api('/grants', 'POST', payload).then(function(){ say('Saved.'); load(); }).catch(function(e){ say(e.message, true); });
    };
    return sel;
  }

  var current = { appRole: {} };

  function row(g, kind){
    var li = document.createElement('li'); li.className = 'row';
    var av = document.createElement('div'); av.className = 'avatar'; av.textContent = initials(g.principal);
    var who = document.createElement('div'); who.className = 'who';
    var nm = document.createElement('div'); nm.className = 'name'; nm.textContent = label(g.principal);
    var ml = document.createElement('div'); ml.className = 'mail'; ml.textContent = kind === 'app' ? ('App ' + g.appRole) : ('Role: ' + (g.featureRole || '—'));
    who.appendChild(nm); who.appendChild(ml);
    li.appendChild(av); li.appendChild(who);
    if(kind === 'app'){
      li.appendChild(roleSelect('app', g.principal, g.appRole, APP_ROLES));
      var va = document.createElement('a'); va.className='viewas'; va.textContent='View as'; va.href = viewAsUrl('app:' + g.appRole); va.target = '_blank'; li.appendChild(va);
    } else {
      li.appendChild(roleSelect('feature', g.principal, g.featureRole, boot.roles));
    }
    var rm = document.createElement('button'); rm.className = 'ghost'; rm.textContent = 'Remove'; rm.type = 'button';
    rm.onclick = function(){ api('/grants/revoke', 'POST', { principal: g.principal }).then(function(){ say('Removed.'); load(); }).catch(function(e){ say(e.message, true); }); };
    li.appendChild(rm);
    return li;
  }

  async function load(){
    try {
      var data = await api('/grants', 'GET');
      boot.roles = data.roles || []; boot.access = data.access;
      current.appRole = {};
      (data.grants || []).forEach(function(g){ current.appRole[g.principal] = g.appRole; });

      var appList = document.getElementById('app-grants'); appList.innerHTML = '';
      data.grants.forEach(function(g){ appList.appendChild(row(g, 'app')); });

      var featList = document.getElementById('feature-grants'); featList.innerHTML = '';
      var withRole = data.grants.filter(function(g){ return g.featureRole; });
      document.getElementById('no-roles').hidden = boot.roles.length > 0;
      withRole.forEach(function(g){ featList.appendChild(row(g, 'feature')); });

      var asel = document.getElementById('assign-role'); asel.innerHTML = '';
      boot.roles.forEach(function(r){ var o = document.createElement('option'); o.value = r; o.textContent = r; asel.appendChild(o); });
      document.getElementById('assign').style.display = boot.roles.length ? 'flex' : 'none';
    } catch(e){ say(e.message, true); }
  }

  document.getElementById('invite').onsubmit = function(ev){
    ev.preventDefault();
    var email = document.getElementById('invite-email').value.trim();
    var role = document.getElementById('invite-role').value;
    if(!email) return;
    api('/grants', 'POST', { principal: email, appRole: role }).then(function(){ document.getElementById('invite-email').value=''; say('Invited.'); load(); }).catch(function(e){ say(e.message, true); });
  };
  document.getElementById('assign').onsubmit = function(ev){
    ev.preventDefault();
    var email = document.getElementById('assign-email').value.trim();
    var role = document.getElementById('assign-role').value;
    if(!email || !role) return;
    api('/grants', 'POST', { principal: email, appRole: current.appRole[email] || 'viewer', featureRole: role }).then(function(){ document.getElementById('assign-email').value=''; say('Assigned.'); load(); }).catch(function(e){ say(e.message, true); });
  };

  load();
})();
`;
