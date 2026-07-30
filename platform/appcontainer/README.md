# 280 app container

The container class every 280 app runs in, with the platform security defaults
locked on. This is what the phase-2 gateway will bind and what the self-hosted
DockerBuilder targets; here it also lets you run one app end to end with
`wrangler dev`.

- `src/container.js` — `App280Container extends Container`. Locked defaults:
  `enableInternet = false` (default-deny egress; the library default is `true`),
  `interceptHttps = true`, `defaultPort = 8080`. `registerEgress()` is the only
  supported way to attach per-host outbound handlers (phase 3), so app authors
  can't trip the `static outboundByHost` class-field footgun the spike documented.
- `src/worker.js` — a thin proof front that forwards to the container. NOT the
  gateway (no OIDC/access/identity; that is phase 2).

The defaults, the HTTP-520 fail-closed on unlisted hosts, and the runtime-CA
mechanism are CONFIRMED on real Cloudflare Containers by the phase-0 egress spike
(`/Users/kishore/Development/firstmate/data/280-p0-egress-spike/report.md`).

## Local end-to-end proof (wrangler dev + Docker)

The app image comes from the CLI buildpack's build context. Materialize a
hello-world Next.js app's context into `proof-context/` (gitignored), then run:

```sh
# 1. build the image the buildpack describes, and run it directly:
cd proof-context
docker build -t 280-hello-proof:local .
docker run --rm -p 8080:8080 280-hello-proof:local &
curl -s localhost:8080 | grep -o 'Hello from 280[^<]*'   # the Next.js app, unchanged

# 2. or run it behind the container class with wrangler dev (needs @cloudflare/containers):
cd ..
npm install
npx wrangler dev            # binds App280Container to ./proof-context, serves on :8787
curl -s localhost:8787 | grep -o 'Hello from 280[^<]*'
```

`proof-context/` is throwaway (gitignored). In production the self-hosted
DockerBuilder builds the app's own image and the gateway binds it by host; nothing
here is per-app committed state.

See `BUILD_HOME.md` for the build-home decision (self-hosted Docker builder).
