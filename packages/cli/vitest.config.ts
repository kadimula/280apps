import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve @280/contracts (and its adapter subpaths) to TS source so tests run
// without a prior build. Subpath aliases must precede the bare package alias so a
// subpath import is not misrouted through index.ts.
const contracts = (rel: string) => fileURLToPath(new URL(`../contracts/src/${rel}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@280/contracts/deploy/fake', replacement: contracts('deploy/fake.ts') },
      { find: '@280/contracts/deploy/http', replacement: contracts('deploy/http.ts') },
      { find: '@280/contracts/deploy/conformance', replacement: contracts('deploy/conformance.ts') },
      { find: '@280/contracts/auth/http', replacement: contracts('auth/http.ts') },
      { find: '@280/contracts', replacement: contracts('index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
