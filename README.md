

# 280apps

<p align="center">
  <img src="readme-hero.png" alt="Secure your internal vibe-coded apps" width="900">
</p>


Professionals across every domain are increasingly using AI coding agents to vibe code internal tools for their teams. However, they quickly encounter several issues:

* Authentication and permissions become complicated, especially for people working in sensitive fields such as finance and health
* Agents write risky security code from scratch every time
* Nontechnical teammates have no easy way to review, adjust, or manage access control

280apps.com is a platform built to solve these problems. It provides:

* A managed environment, backed by Cloudflare Containers, for securely deploying applications, storing and using secrets, and integrating with existing production data sources
* An agent friendly CLI that conforms to the [axi.md](https://axi.md/) format and produces token efficient output
* Tools for deploying apps, adding OAuth, managing secrets, and configuring permissions for you and your team
* Peace of mind, so professionals can continue vibe coding tools without debugging deployments, configuring authentication, or worrying about security

## Find out for yourself

Your agent can determine whether the 280apps platform is right for you:

```
Fetch 280apps.com/setup.md and analyze if the platform is a good fit for my app.
```

Then, when you are ready, ask it to deploy:

```
Fetch 280apps.com/setup.md and push.
```

## Agent facing docs

* [setup.md](packages/backend/src/docs/setup.md): Start here
* [platform-support.md](packages/backend/src/docs/platform-support.md): Current platform support


## Project structure

| Package | Description | Documentation |
| --- | --- | --- |
| `packages/cli` | The CLI (npm `two80`). Push a directory to deploy it. | [README](packages/cli/README.md) |
| `packages/backend` | Control plane for deployment, identity, storage, and agent facing documentation. | [README](packages/backend/README.md) |
| `packages/contracts` | Shared protocol, policy, identity, adapters, and conformance suites. | [README](packages/contracts/README.md) |
| `packages/dashboard` | Web dashboard for managing apps, access, and configuration. | No README yet |
| `packages/egress` | Secure outbound requests, credential injection, and call logging. | [README](packages/egress/README.md) |
| `packages/gateway` | Central identity authority and route enforcement for deployed apps. | [README](packages/gateway/README.md) |
| `packages/sdk` | App identity, capability checks, and scope resolution. | No README yet |



## License

280 is source available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (FSL-1.1-ALv2). You may read, audit, modify, and run the code for any permitted purpose, including for yourself or your team. Offering a competing hosted service is not permitted. Each release also becomes available under the Apache License 2.0 two years after it ships.

**Self hosting vs. managed:** The source is available so you can audit exactly what runs your apps and keeps them secure. Running your own instance requires Cloudflare, Depot, and Postgres accounts and is currently unsupported. The managed service at [280apps.com](https://www.280apps.com) is the recommended option.

**Trademarks:** The "280" and "280apps" names and the 280apps logo are trademarks of Kishore Adimulam. They may not be used for forks or derived services without permission.

## Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="280apps package architecture showing deploy, identity, and request flows" width="1200">
  <br>
  <sub><a href="docs/architecture.dot">Graphviz source</a></sub>
</p>

<p align="center">
  <img src="docs/architecture-mermaid.svg" alt="280apps package architecture rendered from Mermaid source" width="1200">
  <br>
  <sub><a href="docs/architecture.mmd">Mermaid source</a></sub>
</p>
