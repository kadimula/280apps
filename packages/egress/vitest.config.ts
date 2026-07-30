import { defineConfig } from 'vitest/config';

// The egress suites run under node: the outbound handler, the vault, and the
// container-proxy precedence are exercised with in-memory doubles and node's
// global fetch (stubbed), no workerd needed — the request/response semantics the
// handler relies on are identical under node and the Workers runtime.
export default defineConfig({
  test: {
    name: 'egress',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
