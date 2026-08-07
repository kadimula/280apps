# Next.js sample app

A minimal Next.js App Router boilerplate, ready to deploy on 280.

## What's here

- App Router + TypeScript, server components by default.
- `next.config.ts` sets `output: "standalone"` (required by the 280 deploy adapter).
- `lib/visitor.ts` reads identity from the `x-280-*` headers 280 injects at the edge. The app writes no auth.
- `280.json` declares the app name and its one feature.

## Run and deploy

```bash
npm install
npx next build        # 280 does not build for you
npx -y two80@latest push
```

Push relays a sign-in link on first use, prints anything left to fix, then activates a shareable URL.
