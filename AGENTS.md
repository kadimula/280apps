This repo is the source code for 280apps.com, a platform which allows humans to easily and securely share personal apps. This repo holds the 280 CLI, backend code, and contracts.

280apps is built agent-first, with CLI conforming to the [axi.md](https://axi.md/) format.

## Who is 280 best for:

Non technical professionals building internal tools with coding agents. Basic CRUD apps with integrations, a database, file storage, etc. Their team already lives in a workplace identity system (Microsoft, Google). They cannot and should not debug deploys, configure auth, or reason about security.

280 owns the full deploy, identity, sharing, permissions pieces. Reducing the headache of a non-technical professional who is trying to build useful software for themselves and their team

## Agent-facing docs (source of truth)

Owned by the backend (`packages/backend/src/docs.ts`), served as markdown and JSON under `/v1/docs/*` via `docsRoutes()` (one-line mount in `src/api.ts`).

- setup.md (`setupMarkdown()`): the entry prompt agents fetch ("Fetch https://www.280apps.com/setup.md and push"), then run `npx -y two80@latest push` (Node 20+). It carries no support table of its own; it points the agent at the support matrix instead.
- Capabilities matrix: single source in `packages/backend/src/docs.ts`, served as JSON at `/v1/docs/capabilities` and as markdown at `/v1/docs/platform-support.md`. setup.md links to it rather than embedding the table.
- the-280-way (`the280WayMarkdown()`): the build reference agents follow; one blessed answer per need. Next.js App Router + Tailwind/shadcn; provisioned Postgres via Drizzle + serverless driver; R2 for files; identity read from `x-280-user/roles/actions` headers (never write auth); `280.json` manifest declares features, actions, secrets, crons; the Never list (no auth libs, no native modules, no fs writes, no websockets, no long running processes); loop: build with `280 dev`, push, fix what push says, verify URL.

Product and tech vision (direction, not shipped): any app deploys (push instructs, agent converges); auth comes built in (apps hold zero login code, 280 is the front door); sharing works like Docs (grants by email/domain/link, per feature roles, custom actions, instant apply, "view as"). Locked tech decisions: Cloudflare Workers as opinionated harness; edge front door injects signed identity headers and blocks writes for readers; rolled OIDC (Google + Microsoft); per app Postgres + R2; server side builds + boot check with errors translated into agent instructions; `280 dev` proxy injects fake identity locally. Shipped today: push, device login, deploy to Workers.

## Shipped flow (file that owns each step)

- Agent fetches setup.md (`packages/backend/src/docs.ts` `setupMarkdown()`), then runs `npx -y two80@latest push` (Node 20+).
- CLI = `packages/cli` (npm `two80`, bin `280`). `src/push.ts`: sync, upload blobs, poll; auto-inits and bundles (`src/bundle/`). `src/app.ts` `run(env, deps)` is pure, all side effects injected via `Deps`; `src/bin.ts` is the only composition root. Stdout is TOON, proven by golden fixtures `packages/cli/testdata/*.toon` (regenerate with `UPDATE_FIXTURES=1`). `.280/config.json` (committed) binds dir to app; `~/.280/credentials` holds the machine token.
- Device login: `packages/cli/src/login.ts` never blocks; prints link + code, exits `authorization_pending`; agent relays, never opens the link. User approves in the browser (their one action); re-push redeems the token.
- Backend (control plane) = `packages/backend` (npm `@280/backend`): transport `packages/backend/src/api.ts`; behavior `src/deploysvc.ts`; Postgres store `src/store/`; blobs `src/blobstore/`; runtime seam `src/seams.ts`; live substrate `src/runtime/cloudflare/` (Workers for Platforms), `platform/dispatcher/` (root, the edge Worker, NOT `packages/backend`) routes hostname to app script. Last blob landing triggers activation, no separate verb. Edge can lag ~1 min.
- Contracts seam: `packages/contracts` (`deploy`, `auth`, `version` types, zod, Port), consumed by CLI and backend. The CLI bundles it (tsup `noExternal`) so npx works. Adapter subpaths (`@280/contracts/deploy/{http,fake}`, `.../auth/http`) via `exports`. `SyncResult.missing` serializes as `null` when empty.
- Agent integrations: `packages/cli/src/setup/`. `280 setup` JSON-merges (never overwrites) a SessionStart hook into Claude Code, Codex, OpenCode and installs the skill. `packages/cli/skill/SKILL.md` is generated from the home view: `pnpm --filter two80 skill:gen`; CI runs `280 setup --check` to fail on drift.


## Local notes

Private/local notes and infra details live in `CLAUDE.local.md` (gitignored, not committed). Never put secrets (connection strings, keys, tokens, passwords) in this committed file; they belong in `CLAUDE.local.md` or a secrets manager.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
