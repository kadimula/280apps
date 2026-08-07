# two80

https://280apps.com/setup.md - Agents start here

## Commands

Every error prints a `fix` line with the exact command to run next.

| Command | Purpose | Options |
| --- | --- | --- |
| `two80` | Show this directory's app state and next steps | |
| `two80 push` | Build, deploy, and print the live URL | `--name <slug>`, `--framework next\|static`, `--new` |
| `two80 init` | Detect the framework and write `.280/config.json` | `--name <slug>`, `--framework next\|static` |
| `two80 delete` | Destroy this project's app, URL, content, and data | `--yes <name>` |
| `two80 whoami` | Show authentication state | |
| `two80 login` | Authenticate this machine | |
| `two80 setup` | Install agent hooks and the skill | |
| `two80 version` | Show the CLI version | `--version`, `-v` |
| `two80 help` | Show all available commands and flags | `--help`, `-h` |

### `two80 push`

Push initializes new projects automatically. Framework and name options only apply during the first initialization.

| Flag | Description |
| --- | --- |
| `--name <slug>` | Use this app name instead of the `package.json` name |
| `--framework next\|static` | Skip framework detection |
| `--new` | Create a fresh app instead of linking an existing one |

```sh
two80 push
two80 push --name my-app --framework next
two80 push --new
```

### `two80 delete`

Deletion is permanent and requires the app's name as confirmation. Running the command without confirmation prints the required name and deletes nothing.

```sh
two80 delete
two80 delete --yes my-app
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
