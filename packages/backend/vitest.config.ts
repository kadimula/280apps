import { defineConfig } from 'vitest/config';

// Two projects: the node suites, and the AppActivator Durable Object suite that
// must run in workerd (it imports cloudflare:workers, which does not resolve under
// node). The workers project's config lives in vitest.workers.config.ts.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/do/**', '**/node_modules/**'],
        },
      },
      './vitest.workers.config.ts',
    ],
  },
});
