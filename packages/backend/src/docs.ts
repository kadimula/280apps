// docs is the backend home of every agent-facing product doc: the control plane owns
// these because agents fetch them at stable URLs that the frontend only proxies.
// docsRoutes() mounts them as unauthenticated GETs; api.ts wires it in one line.

import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

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
      name: 'Secrets, crons, `two80 dev`',
      status: 'unsupported',
      note: 'Direction, not shipped',
    },
  ],
};

// The full structured matrix consumed by the JSON docs endpoint.
export const SUPPORT_MATRIX: CapabilityGroup[] = [
  ...DEPLOY_STACKS,
  RUNTIME_LIMITS,
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

const SETUP_MARKDOWN = readFileSync(new URL('./docs/setup.md', import.meta.url), 'utf8');
const PLATFORM_SUPPORT_MARKDOWN = readFileSync(
  new URL('./docs/platform-support.md', import.meta.url),
  'utf8',
);

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
  docs.get('/platform-support.md', (c) =>
    c.body(PLATFORM_SUPPORT_MARKDOWN, 200, MARKDOWN_HEADERS),
  );
  docs.get('/capabilities', (c) =>
    c.json(docsCapabilities(), 200, {
      'Cache-Control': 'public, max-age=300',
    }),
  );

  return docs;
}
