// @280/backend: the TS platform (control plane). Exposes the deploy service,
// the HTTP API v1 server, the observability middleware, the internal seams, and
// the Worker's config/deps assembly. The deployable Worker entrypoint itself is
// src/worker.ts (wrangler `main`), imported directly by the runtime rather than
// through this library index.
export * from './seams.js';
export * from './deploysvc.js';
export * from './api.js';
export * from './docs.js';
export * from './observe.js';
export * from './config.js';
export * from './logger.js';
export * from './deps.js';
