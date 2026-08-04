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
      note: 'Default deny; list every host in 280.json egress.allow (others get HTTP 520)',
    },
    {
      name: 'Raw TCP outbound (e.g. Postgres on :5432)',
      status: 'unsupported',
      note: 'Credential injection is HTTPS only; reach a database over its HTTPS endpoint',
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

// A build requirement rather than a capability. The platform routes to port 8080,
// so the app (or a bring your own Dockerfile) must listen there.
export const CAPABILITY_REQUIREMENT =
  'Your app must listen on port 8080 (the platform sets PORT=8080). Next.js and static sites build automatically; any other stack ships a repo root Dockerfile that listens on that port.';

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

280 supports most CRUD apps an internal team builds, but the support set is limited. Check https://280apps.com/platform-support.md first, review the user's stack, and install the CLI only if it is supported. (You can also offer to change the unsupported parts.)

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
  docs.get('/capabilities', (c) =>
    c.json(docsCapabilities(), 200, {
      'Cache-Control': 'public, max-age=300',
    }),
  );

  return docs;
}
