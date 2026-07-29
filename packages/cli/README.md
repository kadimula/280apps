# two80

Deploy and share your app. One verb: `280 push`.

Ask your agent the following to see if 280apps is right for you:

```
Fetch https://www.280apps.com/setup.md and tell me if 280apps is a good fit for my app.
```

Then, when you're ready, ask it to deploy:

```
Fetch https://www.280apps.com/setup.md and push.
```

`two80` is the npm package; `280` is the command it installs. Run it with npx, no install needed:

```sh
npx -y two80@latest push
```

- Runs from the app's directory. Auto-detects Next.js or static.
- First push starts a device login: it prints a link and a code, then exits.
  Approve in the browser, run `push` again.
- Prints the live URL. Re-run to redeploy.

## Commands

```sh
280           # this directory's app state and next steps
280 push      # build, deploy, print the live URL (runs init if new)
280 whoami    # auth state
280 login     # authenticate this machine (prints a link, never waits)
280 delete --yes <name>   # destroy the app: URL, content, data
280 setup     # wire 280 into your agent (see below)
```

## Agent integration

Two paths, install either or both:

- **Session hook** (recommended): `npx -y two80@latest setup` registers a
  SessionStart hook for Claude Code, Codex, and OpenCode. Every session opens
  with this directory's app state already visible. Live state, small per-session
  token cost.
- **Skill**: the same `setup` run installs the on-demand `280-deploy` skill.
  Loads only when the agent recognizes a deploy task. No per-session cost, works
  in any agent supporting the skill format.

Both are opt-in, idempotent, and merge into your agent config without
overwriting it.

## Output contract

- stdout is TOON, for agents. Progress goes to stderr.
- Errors are structured on stdout and carry a runnable fix.
- Exit codes: 0 ok (including no-ops), 1 failure (with a fix), 2 bad flags or args.
