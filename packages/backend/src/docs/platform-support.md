Check this before building or pushing. Anything not listed as supported does not deploy; treat "unverified" as unsupported.

| Stack | Feature | Supported | Notes |
| --- | --- | --- | --- |
| Static HTML | Any static site (HTML, CSS, JS, assets) | yes | Served with SPA fallback to index.html |
| Next.js | Server rendering (SSR, React Server Components) | yes |  |
| Next.js | API routes and route handlers | yes |  |
| Next.js | Static pages (SSG) | yes |  |
| Next.js | Incremental Static Regeneration (ISR) | yes | On disk cache is per instance, not durable across restarts |
| Next.js | Server Actions | yes |  |
| Next.js | Middleware | yes |  |
| Next.js | Image optimization (next/image) | yes |  |
| Next.js | Native and WebAssembly dependencies | yes | Full container, compiled at build time |
| Other stacks | Any language or framework via a repo root Dockerfile | yes | Used as is; the app must listen on port 8080 |
| Runtime | Native modules (sharp, bcrypt, sqlite3, canvas) | yes | Full Node 20 container, built from source |
| Runtime | child_process, worker_threads | yes |  |
| Runtime | Filesystem writes | yes | Local disk only, lost on restart; persist to external storage |
| Runtime | Unrestricted outbound network | no | Default deny; list every host in 280.json egress.allow (others get HTTP 520) |
| Runtime | Raw TCP outbound (e.g. Postgres on :5432) | no | Credential injection is HTTPS only; reach a database over its HTTPS endpoint |
| Runtime | Background work while idle (setInterval, polling loops) | no | A single instance sleeps after about 2 minutes idle; use request handlers |
| Runtime | Websockets | no | Edge proxying of upgrades is unverified; poll instead |
| Platform | Deploy to a shareable URL | yes | One verb, `npx -y two80@latest push` |
| Platform | Device login | yes | CLI prints a link; user approves once per machine |
| Platform | Dashboard at 280apps.com | yes | See, rename, delete apps |
| Platform | Injected identity SDK (@280/sdk: user, can, scope) | yes | Gateway signs a verified identity header; the app reads it via @280/sdk |
| Platform | Feature permissions, sharing grants, route gates | yes | Two-tier roles in 280.json; owner shares in the dialog; gateway enforces |
| Platform | General access modes (invited, anyone-at-tenant, public) | yes | Set in 280.json or the dashboard Share dialog (dashboard wins); public serves anonymous viewers with no sign-in |
| Platform | Per app Postgres and R2 | no | Direction, not shipped |
| Platform | Secrets, crons, `two80 dev` | no | Direction, not shipped |

Your app must listen on port 8080 (the platform sets PORT=8080). Next.js and static sites build automatically; any other stack ships a repo root Dockerfile that listens on that port.