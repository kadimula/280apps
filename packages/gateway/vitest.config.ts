import { defineConfig } from 'vitest/config';

// The gateway suites run under node: the identity scheme and the request flow
// are exercised against WebCrypto and in-memory doubles, no workerd needed. (The
// crypto is plain WebCrypto, identical under node and workerd, so node coverage
// is faithful.)
export default defineConfig({
  test: {
    name: 'gateway',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
