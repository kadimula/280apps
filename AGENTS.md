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
- Backend (control plane) = `packages/backend` (npm `@280/backend`): transport `packages/backend/src/api.ts`; behavior `src/deploysvc.ts`; Postgres store `src/store/`; blobs `src/blobstore/`; runtime seam `src/seams.ts`; live substrate `src/runtime/container/` (apps run UNCHANGED as Cloudflare Containers). The runtime hands each build context to a `ContainerBuilder`: `HttpBuilder` (the Workers control plane can't run Docker, so it ships the context to a self-hosted Docker build host) or `DockerBuilder` (that host / node harness — build image, push to `registry.cloudflare.com`, roll the app's container application). `platform/appcontainer/` holds `App280Container` (locked defaults: `enableInternet=false`, `interceptHttps=true`, buildpack-injected CA entrypoint). The CLI `bundle/container.ts` buildpack turns a repo into that build context (Next.js Dockerfile generated, or a user root `Dockerfile` as the escape hatch); the WfP+OpenNext path is retired. `platform/dispatcher/` (root, the edge Worker, NOT `packages/backend`) is the phase-2 gateway skeleton. Last blob landing triggers activation, no separate verb: the request only enqueues it (`deploysvc` settle) on the per-app `AppActivator` Durable Object (`src/app-activator.ts`, executor `src/activator.ts`), which claims, runs the runtime inline, and retries under an alarm with a stuck-activation watchdog. That object is the cross-isolate per-app serialization point for activation and delete (the retired in-isolate `withAppLock`), so the last blob's 204 now returns before activation completes and the CLI polls Status to a terminal state. Edge can lag ~1 min. Store SQL is schema-qualified through one `t(name)` helper (no `search_path` dependence, for transaction-mode pooling); the idempotent DDL lives once in `src/store/migrations.ts`, applied both on boot (`open()`) and by the CI-only standalone runner `src/migrate.ts` (`pnpm --filter @280/backend migrate`). Migrations are never HTTP-reachable or run at runtime by design. The two-tier permission model (design §5.4) is the flat `grants` table behind the same `Store` seam: `app_role` (owner|admin|editor|viewer) governs the app as an object, `feature_role` is builder-defined per app (custom actions fold into it via `can()`), keyed on (app_id, principal); data model + store methods only, enforcement/gateway wiring is a later phase.
- Contracts seam: `packages/contracts` (`deploy`, `auth`, `version` types, zod, Port), consumed by CLI and backend. The CLI bundles it (tsup `noExternal`) so npx works. Adapter subpaths (`@280/contracts/deploy/{http,fake}`, `.../auth/http`) via `exports`. `SyncResult.missing` serializes as `null` when empty.
- Agent integrations: `packages/cli/src/setup/`. `280 setup` JSON-merges (never overwrites) a SessionStart hook into Claude Code, Codex, OpenCode and installs the skill. `packages/cli/skill/SKILL.md` is generated from the home view: `pnpm --filter two80 skill:gen`; CI runs `280 setup --check` to fail on drift.


## Code style

Avoid comments wherever possible; make the code self-explanatory through naming and structure instead. Prefer a clear function or variable name, a named constant, or a small restructure over a comment that explains what the code does. Add a comment (2 lines maximum) only when the code genuinely cannot be made self-explanatory: a non-obvious "why", a subtle invariant, or a workaround rationale. Never restate the code, narrate the next line, or leave section-divider banners or commented-out code. Load-bearing markers (license headers, tooling directives, `eslint-disable` pragmas, machine-read annotations) stay.

## Local notes

Private/local notes and infra details live in `CLAUDE.local.md` (gitignored, not committed). Never put secrets (connection strings, keys, tokens, passwords) in this committed file; they belong in `CLAUDE.local.md` or a secrets manager.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
