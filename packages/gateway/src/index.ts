// @280/gateway: the edge identity gateway. The deployable Worker entrypoint is
// src/worker.ts (wrangler `main`); this library index exposes the pieces the
// tests, and eventually the @280/sdk, verify against — above all the signed
// identity header scheme (identity.ts), which app code uses to check who is
// calling without talking to the gateway.
export * from './identity.js';
export * from './gateway.js';
export * from './hosts.js';
export * from './access.js';
export * from './upstream.js';
export * from './deps.js';
export * from './config.js';
