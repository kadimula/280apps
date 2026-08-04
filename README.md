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

## License

280 is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (FSL-1.1-ALv2). You may read, audit, modify, and run the code for any permitted purpose, including running it for yourself or your team. Offering a competing hosted service is not permitted. Each release additionally becomes available under the Apache License 2.0 two years after it ships.

**Self-hosting vs. managed:** the source is open so you can audit exactly what runs and secures your apps. Running your own instance requires your own Cloudflare, Depot, and Postgres accounts and is currently unsupported. The managed service at [280apps.com](https://www.280apps.com) is the recommended path.

**Trademarks:** the "280" and "280apps" names and logo are trademarks of Kishore Adimulam and may not be used for forks or derived services without permission.
