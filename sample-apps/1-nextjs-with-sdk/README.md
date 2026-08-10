# Next.js with the 280 SDK

A minimal Next.js App Router application that uses the current `@two80/sdk` identity API.

## What it demonstrates

1. Reading the gateway supplied identity from Next.js request headers
2. Displaying the current user, tenant, app role, and feature role
3. Checking the `manager` capability with `can()`
4. Reading the optional `region` data scope with `scope()`
5. Handling requests that did not pass through the 280 identity gateway

The SDK does not implement database, file, or provider capabilities yet, so this sample does not simulate them.

## Deploy

```bash
npm install
npx -y two80@latest push
```

The identity header is supplied by 280 after deployment. A direct local request does not carry that identity and the application will show the missing identity state.
