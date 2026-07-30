# Container build home (Phase 1 open decision)

The spike (`280-p0-egress-spike`) confirmed Cloudflare does **not** build container images
server-side: `wrangler` builds the image locally with Docker and pushes it to
`registry.cloudflare.com`. The 280 control plane runs on Cloudflare Workers, which cannot run
Docker. So the image must build somewhere that has Docker. The runtime seam is written so this
is the one pluggable boundary (`ContainerBuilder` in `packages/backend/src/runtime/container/`):
the control plane hands a materialized build context to the builder; the builder builds, pushes,
and rolls the container application.

## Options

| Option | Latency | Cost | Ops burden | Fit with async activation |
|---|---|---|---|---|
| **A. Self-hosted Docker builder** (one small always-on VM/service running Docker + wrangler, called over HTTP by the control plane) | Best: warm layer cache, no queue. Spike measured 36s with warm layers. | One small VM. | Own + patch + secure one Docker host that runs builder-supplied contexts. | Best: the `AppActivator` DO enqueues, the builder works async, the DO polls/retries under its alarm. |
| **B. Cloudflare Builds** | Unproven for arbitrary uploaded contexts. | In-ecosystem. | Low. | Poor: it is git-push triggered and Workers-oriented; 280 receives build contexts as uploaded blobs, not git pushes, so triggering it per-deploy is awkward and container-image build support is less proven. |
| **C. External CI (GitHub Actions)** | Worst: queue + cold runners, minutes. | Generous free tier. | Low infra. | Poor: couples every deploy to CI availability + a repo/dispatch mechanism; deploy latency swings into minutes. |

## Recommendation: **A, self-hosted Docker builder**

It keeps deploy latency in the tens-of-seconds band the `AppActivator` DO's alarm/retry/watchdog
already tolerates, gives a warm layer cache (biggest single latency lever), and decouples deploys
from git/CI. The tradeoff is running one Docker host; the design already assumes a build home, and
the builder is isolated behind the `ContainerBuilder` port, so if the captain prefers B or C only
that one impl changes, never the runtime/CLI/contracts above it.

## What ships regardless of the choice

Everything except the production build+push wiring: the reshaped container `Manifest`, the CLI
buildpack that emits the Docker build context, the locked-security-defaults container class, the
`ContainerRuntime` + `ContainerBuilder` seam, and the retirement of the WfP/OpenNext path. The
local proof runs the runtime with a Docker-backed builder (`wrangler dev` + Docker). The one line
wired once the captain decides: which `ContainerBuilder` the Workers control plane hands to the
`AppActivator` DO (`selectRuntime` in `deps.ts`).
