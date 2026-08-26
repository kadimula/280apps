import { defineConfig } from 'vitest/config';

// The backend runs as a plain Node service (src/main.ts, the Railway target), so
// every suite is plain node.
export default defineConfig({
  resolve: {
    // The appcontainer suite imports platform/appcontainer sources, which resolve
    // @cloudflare/containers from their own node_modules where vi.mock cannot
    // intercept it; the real package needs workerd's cloudflare:workers builtin.
    alias: {
      '@cloudflare/containers': new URL('./test/helpers/cloudflare-containers-stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    name: 'node',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
