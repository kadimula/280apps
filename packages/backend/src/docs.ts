// docs is the backend home of every agent-facing product doc: the control plane owns
// these because agents fetch them at stable URLs that the frontend only proxies.
// docsRoutes() mounts them as unauthenticated GETs; api.ts wires it in one line.

import { Hono } from 'hono';

// Single source of truth for what 280 supports today. Not cheaply derivable from the
// CLI bundler, so revisit these rows when a stack, adapter version, or platform
// feature changes.

export type CapabilityStatus = 'supported' | 'unsupported';

export interface Feature {
  name: string;
  status: CapabilityStatus;
  // Why, when not simply supported; a supported row may also add the one detail a
  // "yes" omits.
  note?: string;
}

export interface CapabilityGroup {
  name: string;
  features: Feature[];
}

// The stacks a push understands, each with the features verified end to end.
// Anything not verified is listed unsupported on purpose: a guessed checkmark
// misleads the agent worse than an honest "not yet".
export const DEPLOY_STACKS: CapabilityGroup[] = [
  {
    name: 'Static HTML',
    features: [
      { name: 'Any static site (HTML, CSS, JS, assets)', status: 'supported' },
    ],
  },
  {
    name: 'Next.js',
    features: [
      { name: 'Server rendering (SSR, React Server Components)', status: 'supported' },
      { name: 'API routes and route handlers', status: 'supported' },
      { name: 'Static pages (SSG)', status: 'supported' },
      { name: 'Incremental Static Regeneration (ISR)', status: 'supported' },
      { name: 'Server Actions', status: 'unsupported', note: 'Unverified' },
      { name: 'Middleware', status: 'unsupported', note: 'Unverified' },
      { name: 'Image optimization (next/image)', status: 'unsupported', note: 'Unverified' },
      { name: 'Composable cache ("use cache")', status: 'unsupported', note: 'Planned' },
      { name: 'Custom storage bindings (KV, D1, R2)', status: 'unsupported', note: 'Planned' },
      { name: 'Native Node modules', status: 'unsupported', note: 'Cannot run on Workers' },
      { name: 'WebAssembly dependencies', status: 'unsupported', note: 'Cannot run on Workers' },
    ],
  },
];

// Workers runtime limits that hold regardless of stack. Hard "no"s: an app that
// needs any of them will not run, so the note says what to reach for instead.
export const RUNTIME_LIMITS: CapabilityGroup = {
  name: 'Runtime',
  features: [
    {
      name: 'Native modules (sharp, bcrypt, sqlite3, canvas)',
      status: 'unsupported',
      note: 'Use wasm or WebCrypto equivalents',
    },
    { name: 'child_process, worker_threads, raw sockets', status: 'unsupported' },
    { name: 'Filesystem writes', status: 'unsupported' },
    { name: 'Websockets', status: 'unsupported', note: 'Poll instead' },
    {
      name: 'Long running processes, setInterval',
      status: 'unsupported',
      note: 'Request handlers only, short CPU time per request',
    },
  ],
};

// What the 280 platform gives an app around the deploy. "supported" rows ship today;
// the rest are v2 direction, listed so the agent does not assume they exist yet.
export const PLATFORM_FEATURES: CapabilityGroup = {
  name: 'Platform',
  features: [
    {
      name: 'Deploy to a shareable URL',
      status: 'supported',
      note: 'One verb, `npx -y two80@latest push`',
    },
    {
      name: 'Device login',
      status: 'supported',
      note: 'CLI prints a link; user approves once per machine',
    },
    {
      name: 'Dashboard at 280apps.com',
      status: 'supported',
      note: 'See, rename, delete apps',
    },
    {
      name: 'Injected identity SDK (@280/sdk: user, can, scope)',
      status: 'supported',
      note: 'Gateway signs a verified identity header; the app reads it via @280/sdk',
    },
    {
      name: 'Feature permissions, sharing grants, route gates',
      status: 'supported',
      note: 'Two-tier roles in 280.json; owner shares in the dialog; gateway enforces',
    },
    {
      name: 'General access modes (invited, anyone-at-tenant, public)',
      status: 'supported',
      note: 'Set in 280.json or the dashboard Share dialog (dashboard wins); public serves anonymous viewers with no sign-in',
    },
    {
      name: 'Per app Postgres and R2',
      status: 'unsupported',
      note: 'Direction, not shipped',
    },
    {
      name: 'Secrets, crons, `280 dev`',
      status: 'unsupported',
      note: 'Direction, not shipped',
    },
  ],
};

// The full matrix: deploy stacks, then the runtime limits and platform features that
// apply across all of them. The markdown table and the JSON both render this.
export const SUPPORT_MATRIX: CapabilityGroup[] = [
  ...DEPLOY_STACKS,
  RUNTIME_LIMITS,
  PLATFORM_FEATURES,
];

// A build requirement rather than a capability: the Next.js adapter consumes the
// standalone tree, so the app's next.config must set output: "standalone".
export const CAPABILITY_REQUIREMENT =
  'Next.js requires output: "standalone" in next.config.';

// DocsCapabilities is the JSON the styled /docs page fetches, so both the page and
// the markdown table stay driven by this one list.
export interface DocsCapabilities {
  matrix: CapabilityGroup[];
  requirement: string;
}

export function docsCapabilities(): DocsCapabilities {
  return { matrix: SUPPORT_MATRIX, requirement: CAPABILITY_REQUIREMENT };
}

// Render groups as a markdown table. The group name repeats down its feature rows
// because markdown has no row spanning.
function matrixMarkdown(groups: CapabilityGroup[]): string {
  const rows = groups.flatMap((g) =>
    g.features.map(
      (f) =>
        `| ${g.name} | ${f.name} | ${f.status === 'supported' ? 'yes' : 'no'} | ${f.note ?? ''} |`,
    ),
  );
  return ['| Stack | Feature | Supported | Notes |', '| --- | --- | --- | --- |', ...rows].join(
    '\n',
  );
}

// platformSupportMarkdown renders the full matrix the agent fetches at
// /platform-support.md before it decides whether an app is worth pushing.
export function platformSupportMarkdown(): string {
  return [
    'Check this before building or pushing. Anything not listed as supported does not deploy; treat "unverified" as unsupported.',
    '',
    matrixMarkdown(SUPPORT_MATRIX),
    '',
    CAPABILITY_REQUIREMENT,
  ].join('\n');
}

// The entry doc an agent fetches first. It carries no table of its own; it points at
// /platform-support.md for the matrix.
export function setupMarkdown(): string {
  return `\
280apps.com deploys apps for small teams and manages their auth and permissions.

You and the human build the features; 280 owns deploy, identity, and permissions. It is agent first: nearly everything runs through the CLI. The human only logs in and sets secrets and permissions in the 280 UI.

## 1. Check app compatibility

280 supports most CRUD apps an internal team builds, but the support set is limited. Check https://www.280apps.com/platform-support.md first, review the user's stack, and install the CLI only if it is supported. (You can also offer to change the unsupported parts.)

## 2. Install the CLI and push

    npx -y two80@latest push

Auto-inits new projects. Safe to re-run; every step resumes, nothing duplicates.

## 3. Login (the user's one action)

When push prints a login link, relay it and wait. Never open it yourself.

> Log in to 280 to deploy: <url>

After they confirm, push again.

## 4. Verify, then hand over the link

Push exits with the live URL. The edge can lag up to a minute.

- Broken or stale: wait 30 seconds, retry. Do not re-push yet.
- Still broken after two retries: fix, push again.
- Clean: give the user the live link.
`;
}

// The opinionated build reference an agent fetches before writing app code: one
// blessed answer per need. Direction, not shipped: it describes the v2 experience
// (280.json, identity headers, 280 dev), the companion to setup.md.
export function the280WayMarkdown(): string {
  return `\
# The 280 way

You are an agent building an app that deploys to 280. Follow this exactly. Every need has one answer here. Do not substitute.

Companion to setup.md. This is direction, not all shipped yet.

## The flow

What an agent gets upfront, what the push loop teaches, what stays resident, what is fetched only when a need is live.

\`\`\`mermaid
flowchart TD
    subgraph UP["UPFRONT · one fetch"]
        S["setup.md, tiny<br>verb · login protocol · checklist<br>'push instructs, do exactly that'"]
    end
    S --> A["Assess repo against checklist<br>Next.js or static · Node 20<br>standalone output · no native modules"]
    subgraph LOOP["IN THE LOOP · push output, unmissable"]
        P["npx -y two80@latest push"]
        Q{"result?"}
        H["Relay login link to user, wait<br>the human's one action"]
        F["Instruction: do exactly that<br>may point at a /way page"]
        V["Verify live URL<br>hand link to user"]
        G["Epilogue instruction:<br>run 280 setup once"]
        P --> Q
        Q -->|"login needed"| H --> P
        Q -->|"instruction"| F --> P
        Q -->|"live"| V --> G
    end
    A --> P
    subgraph RES["RESIDENT · every later session"]
        K["Skill + home view<br>principles · identity headers<br>280.json · the Never list"]
    end
    G --> K
    K --> X["User asks for feature X"]
    subgraph OD["ON DEMAND · when the need is live"]
        W["280apps.com/way/need.md<br>email · files · crons · images<br>existing services"]
    end
    X --> W
    F -.->|"pointer in error"| W
    W --> C["Build it the 280 way"]
    C --> P
\`\`\`

## Principles

- You build features. 280 owns deploy, identity, permissions, database, file storage.
- Never write auth. The verified caller arrives from \`@280/sdk\`; there is no login page, no session, no user table in your app.
- Declare, don't configure. Access mode, feature roles, route gates, secrets go in \`280.json\`. 280 enforces them at the gateway.
- No unguarded route. Gate sensitive paths in \`280.json routes\`; any route you do not declare defaults to owner-only (fail closed), so a forgotten gate makes a page unreachable, never exposed. The deploy prints each route and its resolved gate.
- Roles are two tiers. \`app_role\` (owner/admin/editor/viewer) governs the app itself and drives the share dialog; \`roles\` are your app's feature roles, gated at the edge and read via \`can()\`. The owner assigns people in 280, never in your app.
- Read identity with \`can()\`, not headers. \`const { user, can, scope } = await identity(request)\`. \`can("manager")\` is true when the viewer holds that feature role; a link visitor holds none.
- If \`280 push\` returns an instruction, do exactly that, then push again. Never work around it.

## The user wants X, you use Y

| Need | Use | Notes |
| --- | --- | --- |
| Web app | Next.js App Router, TypeScript | Stay inside the 280 supported version range from setup.md |
| UI | Tailwind CSS + shadcn/ui | Server components by default; client components only for interactivity |
| Database | Postgres, already provisioned | \`process.env.DATABASE_URL\`. Drizzle + the serverless driver (runs on Workers). Migrations committed, applied on deploy |
| File uploads / storage | R2 bucket, already provisioned | S3 creds in env. Presigned URLs for browser uploads. Never write to local disk |
| Sign in / user accounts | Nothing. \`@280/sdk\` | \`const { user } = await identity(request)\`. \`user.email\`/\`user.tenant\` are gateway-verified. See snippets below |
| Permissions / roles | Declare \`roles\` + \`routes\` in \`280.json\` | The gateway gates the routes; you branch on \`can("manager")\`. Owner assigns people in the 280 share dialog, not in your app |
| Custom actions (approve, export, vote) | A feature role in \`280.json roles\` | Name the role for the action (e.g. \`"approvals.edit"\`), gate its route, and check \`can("approvals.edit")\`. There is no separate actions concept |
| Existing DB or service (Supabase, internal API) | Keep calling it over HTTPS | Allowlist the host in \`280.json\` egress; declare its key as a credential. 280 attaches the key in-flight, your code holds none. Nothing moves, no connector to build |
| Background / scheduled work | Cron in \`280.json\` hitting a route | Keep each run under a minute of CPU; chunk large jobs |
| Email | Resend under the user's account | API key declared as a secret; the user fills it in 280 once |
| Charts | Recharts, client side | |
| CSV export | Streaming GET route | Build the file in the response stream, not on disk |
| PDF | Print stylesheet + browser print, or a client side lib | No headless Chrome, no server side rendering to PDF |
| Image resizing | wasm library (e.g. photon) or CSS | Never sharp |
| Live updating data | Polling with SWR, 2 to 5s interval | No websockets |
| Payments, external APIs | The user's own accounts | Allowlist the host in \`280.json\` egress; declare the key as a credential so 280 attaches it in-flight |

## Never

| Forbidden | Instead |
| --- | --- |
| NextAuth, Clerk, Auth0, passport, any login code | \`@280/sdk\` (\`identity\` → \`{ user, can, scope }\`) |
| \`child_process\`, ffmpeg, puppeteer, worker_threads | Client side work, or a third party API under the user's account |
| Native modules (sharp, bcrypt, sqlite3, canvas) | wasm or WebCrypto equivalents |
| Writing to the filesystem | R2 for files, Postgres for data |
| SQLite files, Prisma with native engines | Provisioned Postgres + Drizzle |
| \`setInterval\`, long running processes | Crons in \`280.json\` |
| Websockets | Polling |
| Committing \`.env\`, hardcoding keys | Declare in \`280.json\` secrets; owner fills in 280 |
| An admin or mutation route with no gate | Declare it in \`280.json routes\`; undeclared routes are owner-only (fail closed) |
| Cookies named \`280_*\` | Any other prefix. The \`280_\` cookie-name prefix is platform-reserved and stripped before requests reach your app |

## Reference code

\`280.json\` at the repo root is the app's trust boundary: access mode, feature
roles, route gates, secret names, and the egress allowlist. Everything here is
enforced at the gateway, before any of your code runs.

\`\`\`json
{
  "name": "expense-tracker",
  "access": "invited",
  "roles": ["approvals.edit"],
  "routes": [
    { "path": "/admin/*", "require": { "app_role": "admin" } },
    { "path": "/api/approve", "require": { "role": "approvals.edit" } },
    { "path": "/*", "require": { "app_role": "viewer" } }
  ],
  "secrets": ["RESEND_API_KEY"],
  "egress": {
    "allow": ["api.resend.com", "your-project.supabase.co"],
    "credentials": [
      { "host": "api.resend.com", "secret": "RESEND_API_KEY" },
      { "host": "your-project.supabase.co", "secret": "SUPABASE_KEY", "header": "apikey", "scheme": "" }
    ]
  }
}
\`\`\`

- \`access\`: \`invited\` (only people the owner shared with), \`anyone-at-tenant\`
  (anyone in the owner's org), or \`public\` (anyone on the internet, no sign-in;
  such visitors get an anonymous viewer identity). Default \`invited\`. If the
  owner set the mode in the dashboard's Share dialog, that setting wins over this
  field on every deploy — the push output says so when they diverge.
- \`roles\`: your feature roles. A route can require one via \`{ "role": "..." }\`, and
  you check the same name with \`can("...")\`. Name a role for a custom action.
- \`routes\`: \`path\` (globs allowed, \`/admin/*\`) → \`require\` an \`app_role\` floor OR a
  \`role\`. Declare a \`/*\` catch-all for the pages every viewer should reach; any
  path you leave out is owner-only. The deploy prints the route → gate diff.

## Outbound calls (egress)

Your app runs default-deny: it reaches ONLY the hosts you list in \`egress.allow\`;
everything else is blocked. Rules:

- List every external host your app calls in \`egress.allow\` (globs allowed, e.g.
  \`*.supabase.co\`; a glob matches subdomains, not the bare domain).
- For a host that needs a key, add a \`credentials\` entry naming a 280 secret. 280
  attaches it to the request in-flight, outside your container: your code makes a
  plain request with NO auth header, and never holds the key. Default header is
  \`authorization\` with a \`Bearer\` scheme; set \`header\`/\`scheme\` for APIs that want
  a raw key header (\`"scheme": ""\`).
- The provisioned Postgres is reached over its HTTPS endpoint (the neon-http
  serverless driver), allowlisted for you — never a raw \`:5432\` TCP connection,
  which egress can block but not secure. Keep all access on HTTPS interfaces.

Identity comes from \`@280/sdk\` (\`npm i @280/sdk\`). It verifies the gateway's
short-lived signed header offline and hands you one object. That is the only
identity code your app ever contains: no session, no token, no user table.

\`app/reports/page.tsx\`. Read the caller, then branch on \`can()\`. The route gate in
\`280.json\` is the real enforcement; \`can()\` is for showing the right UI.

\`\`\`tsx
import { headers } from "next/headers";
import { identity } from "@280/sdk";

export default async function ReportsPage() {
  const { user, can, scope } = await identity(await headers());

  const canApprove = can("approvals.edit"); // holds the feature role?
  const team = scope("salaries");           // advisory data scope, or null

  return <Reports viewer={user.email} canApprove={canApprove} team={team} />;
}
\`\`\`

For a mutation, gate the route in \`280.json\` (\`{ "path": "/api/approve", "require":
{ "role": "approvals.edit" } }\`); the gateway blocks anyone without the role before
your handler runs, so the handler can trust \`can("approvals.edit")\`.

\`lib/db.ts\`. The entire database setup.

\`\`\`ts
import { drizzle } from "drizzle-orm/neon-http"; // serverless driver, runs on Workers
import * as schema from "./schema";

export const db = drizzle(process.env.DATABASE_URL!, { schema });
\`\`\`

\`app/jobs/daily-sync/route.ts\`. A cron target is a plain route, called by 280 on the declared schedule.

\`\`\`ts
import { db } from "@/lib/db";

export async function POST() {
  await syncExpenses(db); // chunk anything big; stay under a minute
  return Response.json({ ok: true });
}
\`\`\`

## The loop

1. Build with \`280 dev\`
2. Test roles: "view as reader"
3. \`280 push\`
4. Fix what push says, repush
5. Verify live URL, hand link to user

- \`280 dev\` wraps your dev server, injects identity headers locally, and connects the app to a dev branch of its database: real Postgres, same driver, nothing to install. Use its role switcher before every push.
- First push ever: relay the sign in link to the user, wait, push again. Never open the link yourself.
- If push reports missing secrets, relay the link. The user fills them once.
- Edge can lag about a minute after activation. Verify the URL before handing it over.
`;
}

const MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  // These docs move only when a capability or blessed answer does; a short cache
  // keeps a busy agent fleet off the origin.
  'Cache-Control': 'public, max-age=300',
};

// docsRoutes serves every agent-facing doc as an unauthenticated GET, mounted under
// /v1/docs so the doc surface stays out of the transport core.
export function docsRoutes(): Hono {
  const docs = new Hono();

  docs.get('/setup.md', (c) => c.body(setupMarkdown(), 200, MARKDOWN_HEADERS));
  docs.get('/platform-support.md', (c) =>
    c.body(platformSupportMarkdown(), 200, MARKDOWN_HEADERS),
  );
  docs.get('/the-280-way.md', (c) => c.body(the280WayMarkdown(), 200, MARKDOWN_HEADERS));

  docs.get('/capabilities', (c) =>
    c.json(docsCapabilities(), 200, {
      'Cache-Control': 'public, max-age=300',
    }),
  );

  return docs;
}
