// The AppActivator Durable Object suite runs inside workerd (real DO storage and
// alarms) via @cloudflare/vitest-pool-workers. Every other suite is plain node
// (vitest.config.ts); vitest.workspace.ts runs both.
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    name: 'workers',
    include: ['test/do/**/*.test.ts'],
    poolOptions: {
      workers: {
        // One worker for the whole suite, so the module-level test-deps override in
        // app-activator.ts is shared with the Durable Object it configures.
        singleWorker: true,
        // Isolated storage snapshots do not compose with SQLite-backed Durable
        // Objects here (the -shm/-wal sidecars trip the stack unwind). Each test
        // uses a fresh app id — hence a fresh object — instead, so their storage
        // never overlaps.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.test.jsonc' },
      },
    },
  },
});
