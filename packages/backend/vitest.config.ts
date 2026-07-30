import { defineConfig } from 'vitest/config';

// The backend runs as a plain Node service (src/main.ts, the Railway target), so
// every suite is plain node. The AppActivator Durable Object and its workerd-only
// suite were retired with the Workers entrypoint; ActivatorCore's behavior is now
// covered by test/activator-core.test.ts under this config.
export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
