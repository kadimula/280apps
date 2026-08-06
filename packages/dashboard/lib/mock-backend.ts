import type { App } from "@/lib/apps";
import type { DocsCapabilities } from "@/lib/docs";
import type { AppAccess } from "@/lib/grants";
import type { SessionUser } from "@/lib/session";

// The stand-in backend. When MOCK_BACKEND is on, apiFetch routes every call here
// and this module answers it, so the whole dashboard can run with no platform
// reachable. Each endpoint the dashboard calls has one entry below; adding a new
// backend call means adding one case here, and nowhere else.
//
// A development aid, never shipped behavior: lib/api gates it on NODE_ENV so a
// production deploy always talks to the real platform. Keep every response shaped
// exactly like the real handlers (280apps `packages/backend/src/api.ts`).

// The signed-in user the mock reports. Being signed in is the useful default:
// the dashboard and per-app pages only render for a signed-in browser. The
// mock-auth cookie can force it signed out to iterate the landing/sign-in pages.
const MOCK_USER: SessionUser = {
  id: "mock-user",
  email: "you@280apps.com",
  name: "Mock User",
  image: "",
};

// The tenant the mock's owner belongs to. A real org domain (not a consumer mail
// domain) so the Share dialog's "Anyone at ..." option renders enabled.
const MOCK_TENANT = "280apps.com";

// Cookie the mock-auth toggle writes to force the mock signed out. Set to "out",
// /auth/me reports no user; any other state is signed in. Only the mock reads it.
export const MOCK_AUTH_COOKIE = "280-mock-auth";

function mockSignedOut(init?: RequestInit): boolean {
  const cookie = new Headers(init?.headers).get("cookie") ?? "";
  return cookie.split(/; */).some((pair) => pair === `${MOCK_AUTH_COOKIE}=out`);
}

// The app list the dashboard renders. One not-live app exercises the "no live
// app to preview" branch; the live ones drive the embedded preview and View-as.
const MOCK_APPS: App[] = [
  { id: "app-notes", slug: "team-notes", url: "https://team-notes.280apps.run", live: true },
  { id: "app-tracker", slug: "bug-tracker", url: "https://bug-tracker.280apps.run", live: true },
  { id: "app-draft", slug: "new-idea", url: "https://new-idea.280apps.run", live: false },
];

const mockVariableNames: Record<string, string[]> = {
  "app-notes": ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
  "app-tracker": ["LINEAR_API_KEY"],
  "app-draft": [],
};
const mockVariables = new Map<
  string,
  Map<string, { value: string; setBy: string; setAt: number }>
>();

// The capability matrix the /docs page renders, shaped exactly like the real
// /v1/docs/capabilities payload so the page's table renders unchanged.
const MOCK_CAPABILITIES: DocsCapabilities = {
  requirement:
    "Apps run as a single web process that listens on $PORT and serves over HTTP.",
  matrix: [
    {
      name: "Runtimes",
      features: [
        { name: "Node.js", status: "supported" },
        { name: "Python", status: "supported" },
        { name: "Bun", status: "supported", note: "Detected from bun.lockb." },
        { name: "Go", status: "unsupported", note: "On the roadmap." },
      ],
    },
    {
      name: "Frameworks",
      features: [
        { name: "Next.js", status: "supported" },
        { name: "Vite / static", status: "supported" },
        { name: "FastAPI", status: "supported" },
        { name: "Long-running workers", status: "unsupported" },
      ],
    },
    {
      name: "Storage",
      features: [
        { name: "Environment secrets", status: "supported" },
        { name: "Managed Postgres", status: "supported" },
        { name: "Local disk", status: "unsupported", note: "Filesystem is ephemeral." },
      ],
    },
  ],
};

const MOCK_DOCS: Record<string, string> = {
  "setup.md": `# Push to 280

1. Build your app locally. It listens on \`$PORT\` and serves over HTTP.
2. Tell your agent to push to 280. It builds, deploys, and reads the logs.
3. You get a private link to share.

That's the whole loop.
`,
  "the-280-way.md": `# The 280 way

Your agent writes the code and pushes it. You log in, set secrets and
permissions, and share the link. Deployment and access are 280's job.
`,
  "platform-support.md": `# Platform support

280 runs a single web process that listens on \`$PORT\`. See the capability
matrix on the docs page for supported runtimes and frameworks.
`,
};

// Per-app grant lists for the Share dialog, held in memory so add/remove
// round-trips survive the dialog's own load-after-mutate reloads. Each app
// starts with its owner row, the way the real store seeds the deploying owner.
type MockGrant = {
  principal: string;
  appRole: string;
  featureRole: string;
  grantedBy: string;
  grantedAt: number;
};

const mockGrants = new Map<string, MockGrant[]>();

function grantsFor(appId: string): MockGrant[] {
  let grants = mockGrants.get(appId);
  if (!grants) {
    grants = [
      {
        principal: MOCK_USER.email,
        appRole: "owner",
        featureRole: "",
        grantedBy: MOCK_USER.email,
        grantedAt: Math.floor(Date.now() / 1000),
      },
    ];
    mockGrants.set(appId, grants);
  }
  return grants;
}

// The General-access dial's state per app. Starts from 280.json (manifest) and
// flips to a durable dashboard override the moment the dial is changed, mirroring
// how app_policies.access_override wins over the manifest on the real backend.
type MockAccess = { access: AppAccess; source: "manifest" | "dashboard" };
const mockAccess = new Map<string, MockAccess>();

function accessFor(appId: string): MockAccess {
  let state = mockAccess.get(appId);
  if (!state) {
    state = { access: "invited", source: "manifest" };
    mockAccess.set(appId, state);
  }
  return state;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// A stable stand-in for the opaque grant token. Deterministic on purpose: the
// preview URL is server-rendered into an iframe src, and a random token would
// differ between the SSR and hydration renders and trip a hydration mismatch.
// Same seed (app + view-as target) always yields the same token.
function mockGrantToken(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

// mockResponse answers a single API call. It matches on method + path exactly as
// the real backend routes and returns the same status codes the callers handle
// (204 for a successful mutation, 428 for a bad delete confirmation, 400 with a
// human message for a bad email) so mock mode exercises the real UI branches.
export function mockResponse(path: string, init?: RequestInit): Response {
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "GET" && path === "/auth/me") {
    return json({ user: mockSignedOut(init) ? null : MOCK_USER });
  }

  if (method === "GET" && path === "/internal/apps") {
    return json({ apps: MOCK_APPS });
  }

  // Docs. The structured matrix is matched before the markdown catch-all, since
  // both share the /v1/docs/ prefix.
  if (method === "GET" && path === "/v1/docs/capabilities") {
    return json(MOCK_CAPABILITIES);
  }
  if (method === "GET" && path.startsWith("/v1/docs/")) {
    const name = path.slice("/v1/docs/".length);
    const body = MOCK_DOCS[name] ?? `# ${name}\n\nMock document.\n`;
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  // Delete an app. 428 for the wrong confirmation is the one failure the delete
  // dialog can fix itself, so the mock enforces it and the confirm flow works.
  if (method === "POST" && /^\/internal\/apps\/[^/]+\/delete$/.test(path)) {
    const { confirm } = readBody(init);
    if (confirm !== "delete") return new Response(null, { status: 428 });
    return new Response(null, { status: 204 });
  }

  const variablesMatch = path.match(/^\/internal\/apps\/([^/]+)\/secrets$/);
  if (variablesMatch) {
    const appId = decodeURIComponent(variablesMatch[1]);
    const names = mockVariableNames[appId] ?? [];
    const configured = mockVariables.get(appId) ?? new Map();
    if (method === "GET") {
      return json({
        secrets: names.map((name) => {
          const state = configured.get(name);
          return state
            ? { name, configured: true, setBy: state.setBy, setAt: state.setAt }
            : { name, configured: false };
        }),
      });
    }
    if (method === "POST") {
      const { name, value } = readBody(init);
      if (typeof name !== "string" || !names.includes(name)) {
        return json({ error: `"${String(name)}" is not declared in this app's 280.json` }, 422);
      }
      if (typeof value !== "string" || !value) {
        return json({ error: "A value is required." }, 422);
      }
      configured.set(name, {
        value,
        setBy: MOCK_USER.email,
        setAt: Math.floor(Date.now() / 1000),
      });
      mockVariables.set(appId, configured);
      return new Response(null, { status: 204 });
    }
  }

  const variableActionMatch = path.match(
    /^\/internal\/apps\/([^/]+)\/secrets\/(reveal|delete)$/,
  );
  if (method === "POST" && variableActionMatch) {
    const appId = decodeURIComponent(variableActionMatch[1]);
    const { name } = readBody(init);
    const configured = mockVariables.get(appId) ?? new Map();
    if (typeof name !== "string") return json({ error: "A name is required." }, 422);
    if (variableActionMatch[2] === "reveal") {
      const variable = configured.get(name);
      return variable
        ? json({ value: variable.value })
        : json({ error: "This variable has no value." }, 400);
    }
    configured.delete(name);
    mockVariables.set(appId, configured);
    return new Response(null, { status: 204 });
  }

  // The Share dialog's grant list. Carries the access fields the dialog's
  // General-access section reads, alongside the rows themselves.
  const grantsMatch = path.match(/^\/internal\/apps\/([^/]+)\/grants$/);
  if (method === "GET" && grantsMatch) {
    const appId = decodeURIComponent(grantsMatch[1]);
    const state = accessFor(appId);
    return json({
      grants: grantsFor(appId),
      access: state.access,
      accessSource: state.source,
      ownerTenant: MOCK_TENANT,
      ownerTenantIsConsumer: false,
    });
  }
  // Add a grant. Mirrors the real handler's branches: principals normalize to
  // lowercase, a malformed email is a 400 with a human message, mutation is 204.
  if (method === "POST" && grantsMatch) {
    const { principal, appRole } = readBody(init);
    const email =
      typeof principal === "string" ? principal.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "That doesn't look like an email address." }, 400);
    }
    if (typeof appRole !== "string" || !appRole) {
      return json({ error: "A role is required." }, 400);
    }
    const grants = grantsFor(decodeURIComponent(grantsMatch[1]));
    const grant: MockGrant = {
      principal: email,
      appRole,
      featureRole: "",
      grantedBy: MOCK_USER.email,
      grantedAt: Math.floor(Date.now() / 1000),
    };
    const existing = grants.find((g) => g.principal === email);
    if (existing) Object.assign(existing, grant);
    else grants.push(grant);
    return new Response(null, { status: 204 });
  }
  // Revoke a grant. The last-owner guard trips exactly as the real store's does.
  const revokeMatch = path.match(/^\/internal\/apps\/([^/]+)\/grants\/revoke$/);
  if (method === "POST" && revokeMatch) {
    const appId = decodeURIComponent(revokeMatch[1]);
    const { principal } = readBody(init);
    const email =
      typeof principal === "string" ? principal.trim().toLowerCase() : "";
    const grants = grantsFor(appId);
    const target = grants.find((g) => g.principal === email);
    if (
      target?.appRole === "owner" &&
      grants.filter((g) => g.appRole === "owner").length === 1
    ) {
      return json({ error: "An app needs at least one owner." }, 400);
    }
    mockGrants.set(
      appId,
      grants.filter((g) => g.principal !== email),
    );
    return new Response(null, { status: 204 });
  }

  // The General-access dial's write. Sets a durable dashboard override, so the
  // next grants load reports the new mode with accessSource "dashboard".
  const accessMatch = path.match(/^\/internal\/apps\/([^/]+)\/access$/);
  if (method === "POST" && accessMatch) {
    const { access } = readBody(init);
    if (access !== "invited" && access !== "anyone-at-tenant" && access !== "public") {
      return json({ error: "Unknown access mode." }, 400);
    }
    mockAccess.set(decodeURIComponent(accessMatch[1]), {
      access,
      source: "dashboard",
    });
    return new Response(null, { status: 204 });
  }

  // The preview grant. The real backend returns an opaque grant plus the
  // app-host bootstrap URL (/__280/preview?g=...); the mock returns the same
  // shape but points the URL at this app's own dev-only stand-in page, so the
  // embedded preview and "View as" render offline, identity echo included.
  const previewMatch = path.match(/^\/internal\/apps\/([^/]+)\/preview-grant$/);
  if (method === "POST" && previewMatch) {
    const app = MOCK_APPS.find((a) => a.id === decodeURIComponent(previewMatch[1]));
    if (!app?.live) return json({ error: "no live app to preview" }, 404);
    const viewAs = readBody(init).viewAs as
      | { kind?: string; email?: string; appRole?: string; featureRole?: string }
      | undefined;
    const who =
      viewAs?.kind === "user" && viewAs.email
        ? viewAs.email
        : viewAs?.kind === "role"
          ? `${MOCK_USER.email} as ${viewAs.appRole || viewAs.featureRole}`
          : `${MOCK_USER.email} (owner)`;
    const grant = mockGrantToken(`${app.id}|${who}`);
    return json({
      grant,
      expiresIn: 900,
      url: `/mock/preview?slug=${encodeURIComponent(app.slug)}&host=${encodeURIComponent(
        app.url.replace(/^https:\/\//, ""),
      )}&who=${encodeURIComponent(who)}&g=${grant}`,
    });
  }

  // Device approval succeeds with 204, the code the /activate flow keys on.
  if (method === "POST" && path === "/internal/device/approve") {
    return new Response(null, { status: 204 });
  }

  // An unmocked call fails loudly rather than hanging, so a missing mock is
  // obvious the first time a new endpoint is added.
  return json({ error: `No mock for ${method} ${path}` }, 404);
}
