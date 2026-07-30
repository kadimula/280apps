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
      name: 'Identity headers (x-280-user, x-280-roles, x-280-actions)',
      status: 'unsupported',
      note: 'Direction, not shipped',
    },
    {
      name: 'Feature permissions, sharing grants',
      status: 'unsupported',
      note: 'Direction, not shipped',
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
280apps.com is a platform which allows easy deployment, auth, and permission management of apps in small teams.

The human and agent stay responsible for building features. 280 is built agent first: the vast majority of actions run through the agent's CLI. The only steps the human takes are login, plus secrets and permission controls in the 280 UI. All feature development happens through their coding agent, as it does today.

## 1. Check app compatibility with 280

280apps.com supports the majority of CRUD applications an internal team might build, but its support set is limited. First check https://www.280apps.com/platform-support.md to see what 280 supports. Review the stack of the user's current app, and only if it is supported there is it worth installing the CLI. (If they really want to deploy to 280, you can also suggest modifying the unsupported sections of their app.)

## 2. Install the 280 CLI and push

    npx -y two80@latest push

Auto inits new projects. Safe to re-run; every step resumes, nothing duplicates.

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
- Never write auth. Identity arrives as request headers. There is no login page in your app.
- Declare, don't configure. Features, secrets, crons go in \`280.json\`. 280 does the rest.
- Reads are GETs. Mutations are POSTs. 280 blocks POSTs for readers at the edge.
- A feature is a route subtree. One folder per feature. Its name appears verbatim in the owner's sharing UI.
- Features can declare custom actions (approve, export, vote). 280 grants them per person. You read \`x-280-actions\` and enforce. Edge reports, app enforces.
- Every page must render for role reader. Link visitors arrive as \`x-280-user: anonymous\`, name Guest, reader on every feature; never treat the email as a real address without handling \`anonymous\`.
- If \`280 push\` returns an instruction, do exactly that, then push again. Never work around it.

## The user wants X, you use Y

| Need | Use | Notes |
| --- | --- | --- |
| Web app | Next.js App Router, TypeScript | Stay inside the 280 supported version range from setup.md |
| UI | Tailwind CSS + shadcn/ui | Server components by default; client components only for interactivity |
| Database | Postgres, already provisioned | \`process.env.DATABASE_URL\`. Drizzle + the serverless driver (runs on Workers). Migrations committed, applied on deploy |
| File uploads / storage | R2 bucket, already provisioned | S3 creds in env. Presigned URLs for browser uploads. Never write to local disk |
| Sign in / user accounts | Nothing. Read the headers | \`x-280-user\`, \`x-280-roles\`, \`x-280-actions\`. See snippets below |
| Permissions / roles | Declare features in \`280.json\` | Gate nav and pages by role headers. Owner assigns people in 280, not in your app |
| Custom actions (approve, export, vote) | Declare per feature in \`280.json\` | 280 grants them; you enforce from \`x-280-actions\`. Edge reports, app enforces |
| Existing DB or service (Supabase, internal API) | Keep calling it | Store its URL and keys as 280 secrets. Nothing moves, no connector to build |
| Background / scheduled work | Cron in \`280.json\` hitting a route | Keep each run under a minute of CPU; chunk large jobs |
| Email | Resend under the user's account | API key declared as a secret; the user fills it in 280 once |
| Charts | Recharts, client side | |
| CSV export | Streaming GET route | Build the file in the response stream, not on disk |
| PDF | Print stylesheet + browser print, or a client side lib | No headless Chrome, no server side rendering to PDF |
| Image resizing | wasm library (e.g. photon) or CSS | Never sharp |
| Live updating data | Polling with SWR, 2 to 5s interval | No websockets |
| Payments, external APIs | The user's own accounts | Every key is a declared secret, read from env |

## Never

| Forbidden | Instead |
| --- | --- |
| NextAuth, Clerk, Auth0, passport, any login code | 280 identity headers |
| \`child_process\`, ffmpeg, puppeteer, worker_threads | Client side work, or a third party API under the user's account |
| Native modules (sharp, bcrypt, sqlite3, canvas) | wasm or WebCrypto equivalents |
| Writing to the filesystem | R2 for files, Postgres for data |
| SQLite files, Prisma with native engines | Provisioned Postgres + Drizzle |
| \`setInterval\`, long running processes | Crons in \`280.json\` |
| Websockets | Polling |
| Committing \`.env\`, hardcoding keys | Declare in \`280.json\` secrets; owner fills in 280 |
| Mutating state in a GET handler | POST. Readers are blocked from POST at the edge |
| Next.js Server Actions | Route handlers. Actions are POSTs the edge cannot tell apart, so the reader block would break them |

## Reference code

\`280.json\` at the repo root. The whole contract: app name, features, secrets, crons.

\`\`\`json
{
  "name": "expense-tracker",
  "features": [
    { "key": "reports", "name": "Reports", "routes": "/reports", "actions": ["approve", "export"] },
    { "key": "billing", "name": "Billing", "routes": "/billing" }
  ],
  "secrets": ["RESEND_API_KEY"],
  "crons": [
    { "schedule": "0 6 * * *", "route": "/jobs/daily-sync" }
  ]
}
\`\`\`

\`lib/visitor.ts\`. The only identity code the app ever contains.

\`\`\`ts
import { headers } from "next/headers";

export type Role = "editor" | "reader";

export async function visitor() {
  const h = await headers();
  const roles: Record<string, Role> = {};
  for (const pair of (h.get("x-280-roles") ?? "").split(";")) {
    const [feature, role] = pair.trim().split("=");
    if (feature && role) roles[feature] = role as Role;
  }
  const actions: Record<string, string[]> = {};
  for (const pair of (h.get("x-280-actions") ?? "").split(";")) {
    const [feature, list] = pair.trim().split("=");
    if (feature && list) actions[feature] = list.split(",");
  }
  return {
    email: h.get("x-280-user") ?? "", // "anonymous" for link visitors (GET only)
    name: h.get("x-280-name") ?? "",
    roles,
    actions,
  };
}
\`\`\`

\`app/reports/page.tsx\`. Gate every feature page: no role, no page. Same check hides the nav link. Actions gate buttons inside the page.

\`\`\`tsx
import { notFound } from "next/navigation";
import { visitor } from "@/lib/visitor";

export default async function ReportsPage() {
  const { roles, actions } = await visitor();
  if (!roles.reports) notFound(); // feature invisible without a role
  const canEdit = roles.reports === "editor";
  const canExport = actions.reports?.includes("export") ?? false;

  return <Reports readOnly={!canEdit} canExport={canExport} />;
}
\`\`\`

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
