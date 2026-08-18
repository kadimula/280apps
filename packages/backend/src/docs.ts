// docs is the backend home of every agent-facing product doc: the control plane owns
// these because agents fetch them at stable URLs that the frontend only proxies.
// docsRoutes() mounts them as unauthenticated GETs; api.ts wires it in one line.

import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import {
  CAPABILITY_CATALOG_VERSION,
  capabilityNames,
  capabilityOperations,
  type CapabilityName,
} from '@280/contracts';

// Structured capabilities consumed by the current landing page docs route.

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

// The stacks a push understands. Every app runs unchanged in its own container
// (a Debian Node 20 image: `next build` + `next start`, or a tiny static server),
// so anything that works under plain `next start` works here. A repo root
// Dockerfile is the escape hatch for any other stack.
export const DEPLOY_STACKS: CapabilityGroup[] = [
  {
    name: 'Static HTML',
    features: [
      {
        name: 'Any static site (HTML, CSS, JS, assets)',
        status: 'supported',
        note: 'Served with SPA fallback to index.html',
      },
    ],
  },
  {
    name: 'Next.js',
    features: [
      { name: 'Server rendering (SSR, React Server Components)', status: 'supported' },
      { name: 'API routes and route handlers', status: 'supported' },
      { name: 'Static pages (SSG)', status: 'supported' },
      {
        name: 'Incremental Static Regeneration (ISR)',
        status: 'supported',
        note: 'On disk cache is per instance, not durable across restarts',
      },
      { name: 'Server Actions', status: 'supported' },
      { name: 'Middleware', status: 'supported' },
      { name: 'Image optimization (next/image)', status: 'supported' },
      {
        name: 'Native and WebAssembly dependencies',
        status: 'supported',
        note: 'Full container, compiled at build time',
      },
    ],
  },
  {
    name: 'Other stacks',
    features: [
      {
        name: 'Any language or framework via a repo root Dockerfile',
        status: 'supported',
        note: 'Used as is; the app must listen on port 8080',
      },
    ],
  },
];

// Runtime facts that hold across stacks now that apps run in a real container.
// The Workers-era bans on native code, threads, and disk are gone; what remains
// is the security and lifecycle shape of the container itself.
export const RUNTIME_LIMITS: CapabilityGroup = {
  name: 'Runtime',
  features: [
    {
      name: 'Native modules (sharp, bcrypt, sqlite3, canvas)',
      status: 'supported',
      note: 'Full Node 20 container, built from source',
    },
    { name: 'child_process, worker_threads', status: 'supported' },
    {
      name: 'Filesystem writes',
      status: 'supported',
      note: 'Local disk only, lost on restart; persist to external storage',
    },
    {
      name: 'Unrestricted outbound network',
      status: 'unsupported',
      note: 'Default deny; containers can reach only the 280 SDK API host (others get HTTP 520)',
    },
    {
      name: 'Raw TCP outbound (e.g. Postgres on :5432)',
      status: 'unsupported',
      note: 'Use an available @two80/sdk capability instead',
    },
    {
      name: 'Background work while idle (setInterval, polling loops)',
      status: 'unsupported',
      note: 'A single instance sleeps after about 2 minutes idle; use request handlers',
    },
    {
      name: 'Websockets',
      status: 'unsupported',
      note: 'Edge proxying of upgrades is unverified; poll instead',
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
      name: 'Injected identity SDK (@two80/sdk: user, can, scope)',
      status: 'supported',
      note: 'Gateway signs a verified identity header; the app reads it via @two80/sdk',
    },
    {
      name: 'Fixed SDK API network boundary',
      status: 'supported',
      note: 'Cloudflare permits only the platform supplied TWO80_API host',
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
      name: 'Config env vars the app reads (280.json config)',
      status: 'supported',
      note: 'Non-credential values such as ids, regions, and flags reach process.env',
    },
    {
      name: 'Per app Postgres and R2',
      status: 'unsupported',
      note: 'Direction, not shipped',
    },
    {
      name: 'Secrets, crons, `two80 dev`',
      status: 'unsupported',
      note: 'Direction, not shipped',
    },
  ],
};

// Every SDK capability and its operations, derived from the single @280/contracts
// catalog so docs, the styled matrix, and runtime validation cannot drift. Adding a
// capability or operation to the catalog is the only edit; everything here follows.
export interface CapabilityDoc {
  slug: CapabilityName;
  title: string;
  operations: string[];
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function capabilityDocs(): CapabilityDoc[] {
  return capabilityNames().map((slug) => ({
    slug,
    title: titleFromSlug(slug),
    operations: [...capabilityOperations(slug)],
  }));
}

// The catalog rendered as a matrix group: one supported row per capability, its
// operations spelled out. Generated, never hand-edited.
export const SDK_CAPABILITIES: CapabilityGroup = {
  name: 'SDK capabilities (@two80/sdk)',
  features: capabilityDocs().map((c) => ({
    name: c.title,
    status: 'supported',
    note: `Operations: ${c.operations.join(', ')}`,
  })),
};

// The full structured matrix consumed by the JSON docs endpoint.
export const SUPPORT_MATRIX: CapabilityGroup[] = [
  ...DEPLOY_STACKS,
  RUNTIME_LIMITS,
  SDK_CAPABILITIES,
  PLATFORM_FEATURES,
];

// A build requirement rather than a capability. The platform routes to port 8080,
// so the app (or a bring your own Dockerfile) must listen there.
export const CAPABILITY_REQUIREMENT =
  'Your app must listen on port 8080 (the platform sets PORT=8080). Next.js and static sites build automatically; any other stack ships a repo root Dockerfile that listens on that port.';

// DocsCapabilities is the JSON the styled /docs page fetches.
export interface DocsCapabilities {
  matrix: CapabilityGroup[];
  requirement: string;
}

export function docsCapabilities(): DocsCapabilities {
  return { matrix: SUPPORT_MATRIX, requirement: CAPABILITY_REQUIREMENT };
}

function stackRows(): string {
  return DEPLOY_STACKS.flatMap((group) =>
    group.features.map((f) => `| ${group.name} | ${f.name}${f.note ? ` — ${f.note}` : ''} |`),
  ).join('\n');
}

function unsupportedRows(): string {
  return RUNTIME_LIMITS.features
    .filter((f) => f.status === 'unsupported')
    .map((f) => `| ${f.name} | ${f.note ?? ''} |`)
    .join('\n');
}

// The capability reference agents read before pushing. The capability/operation
// section is generated from the @280/contracts catalog: a capability or operation
// missing from the catalog cannot appear here, and a new one appears automatically.
export function capabilitiesMarkdown(): string {
  const docs = capabilityDocs();
  const capabilityTable = docs
    .map((c) => `| ${c.title} | \`${c.slug}\` | ${c.operations.map((op) => `\`${op}\``).join(', ')} |`)
    .join('\n');
  const example = docs[0] ?? { slug: 'google-sheets', operations: ['read', 'append', 'update', 'deleteRows'] };
  const exampleOps = example.operations.map((op) => `"${op}"`).join(', ');

  return `# 280 capability reference

Generated from the \`@280/contracts\` capability catalog (version ${CAPABILITY_CATALOG_VERSION}). This is the authoritative list of what a 280 app may do; \`setup.md\` links here. If a required operation is not listed as supported, stop and report it rather than working around the network boundary.

## Supported stacks

${CAPABILITY_REQUIREMENT}

| Stack | Notes |
| --- | --- |
${stackRows()}

## SDK capabilities

Every external integration goes through \`@two80/sdk\`. The container reaches only the 280 API, which authorizes each call for the current app and user; the app holds no provider credentials.

| Capability | Slug | Operations |
| --- | --- | --- |
${capabilityTable}

Declare every integration the app uses in \`280.json\` as an alias mapped to its capability and the operations it calls, so push can gate the deploy until that alias is connected. The alias (\`todos\` below) is your app-chosen name; 280 binds it to a real resource at connect time.

    { "integrations": { "todos": { "capability": "${example.slug}", "operations": [${exampleOps}] } } }

### Request scoping

Every capability is a factory that takes the **incoming request** and returns a typed client scoped to the current caller. Nothing is global or cached across requests: the SDK reads the gateway-stamped identity header off the request you pass and forwards it, so the 280 API can authorize the call for this app and this user. Pass whatever exposes the request headers where you handle the request:

- a Fetch \`Request\` (its \`.headers\` are read for you): \`googleSheets(request)\`
- Next's \`headers()\` result: \`googleSheets(await headers())\`

Read identity from the same request the same way, via \`identity()\`:

    import { identity } from "@two80/sdk";

    export async function GET(request: Request) {
      const { user, can, anonymous } = await identity(request);
      user.email;             // resolved by the gateway, never by app code
      can("approvals.edit");  // true when the viewer holds that feature role
      anonymous;              // true for a public app's no-session visitor
    }

### Framework example: Google Sheets

    import { googleSheets } from "@two80/sdk";

    // In a Next.js route handler or Server Action, pass the incoming request.
    export async function POST(request: Request) {
      const sheets = googleSheets(request);
      // "todos" is the alias from 280.json, not a spreadsheet id.
      await sheets.read({ resource: "todos", range });            // -> { range, majorDimension, values }
      await sheets.append({ resource: "todos", range, values });  // -> { updatedRange, updatedRows, updatedCells }
      await sheets.update({ resource: "todos", range, values });  // -> { updatedRange, updatedRows, updatedCells }
    }

\`resource\` is the alias you declared in \`280.json\` (e.g. \`"todos"\`), not a spreadsheet id: 280 binds that alias to a real sheet at connect time, so the app never carries a raw sheet id. \`range\` is A1 notation (e.g. \`Sheet1!A1:C10\`), and \`values\` is a 2D array. A failed call throws \`IntegrationRequestError\` with \`{ code, message, status, retryable }\`. Full package docs: <https://www.npmjs.com/package/@two80/sdk>.

## Explicitly unsupported

The container runs full Node 20, so native modules, child processes, and local disk writes all work. What the boundary forbids:

| Not supported | Do this instead |
| --- | --- |
${unsupportedRows()}

Provider SDKs, raw API calls, connection strings, and any app-managed credential are unsupported by design: route the need through an \`@two80/sdk\` capability, or report it as missing.
`;
}

const SETUP_MARKDOWN = readFileSync(new URL('./docs/setup.md', import.meta.url), 'utf8');

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

  docs.get('/setup.md', (c) => c.body(SETUP_MARKDOWN, 200, MARKDOWN_HEADERS));
  docs.get('/capabilities.md', (c) => c.body(capabilitiesMarkdown(), 200, MARKDOWN_HEADERS));
  docs.get('/capabilities', (c) =>
    c.json(docsCapabilities(), 200, {
      'Cache-Control': 'public, max-age=300',
    }),
  );

  return docs;
}
