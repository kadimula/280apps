# 280apps

Source code for [280apps.com](https://www.280apps.com) the platform, which enables humans to easily and securely share personal apps.

280 owns the full deploy, identity, sharing, and permissions story so non-tech professionals can build internal tools with coding agents, without ever debugging deploys, configuring auth, or reasoning about security. The platform is built agent-first, with the CLI conforming to the [axi.md](https://axi.md/) format (token efficiency & agent friendly outputs).

## Ask for yourself

Your agent can answer if the 280apps platform is right for you:

```
Fetch 280apps.com/setup.md and analyze if the platform is a good fit for my app.
```

Then, when you're ready, ask it to deploy:

```
Fetch 280apps.com/setup.md and push.
```

## What's here

| Package | What it is |
| --- | --- |
| `packages/cli` | The `280` CLI (npm `two80`). Push a directory, it deploys. |
| `packages/backend` | Control plane: deploy, identity, storage, agent facing docs. |
| `packages/contracts` | Shared types and adapters between CLI and backend. |

## Docs

Agent facing docs are served live under `/v1/docs/*`. Start at [280apps.com/setup.md](https://www.280apps.com/setup.md).
