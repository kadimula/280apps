import { defineConfig } from 'vitest/config';

// The backend runs as a plain Node service (src/main.ts, the Railway target), so
// every suite is plain node.
export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
