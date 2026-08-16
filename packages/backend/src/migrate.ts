// migrate: the standalone control-plane migration runner, CI-only. It applies the
// same shared idempotent statement list the store applies on boot
// (store/migrations.ts). It dials a direct primary connection, never a
// transaction-mode pooler (which DDL must not use), and is not reachable at runtime:
// a standing endpoint that runs DDL is attack surface.

import { PLATFORM_POLICY } from '@280/contracts/platform-config';
import pg from 'pg';
import { migrations } from './store/migrations.js';

const { Client } = pg;

// MIGRATE_DATABASE_URL wins when set, so CI can point at the primary even when
// DATABASE_URL is a pooled/Hyperdrive endpoint; otherwise DATABASE_URL.
function dsn(): string {
  return process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
}

export async function migrate(): Promise<void> {
  const url = dsn();
  if (url === '') {
    throw new Error('migrate: set MIGRATE_DATABASE_URL or DATABASE_URL');
  }
  // Validates the schema and throws on a bad identifier before any connection opens.
  const stmts = migrations(PLATFORM_POLICY.databaseSchema);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const stmt of stmts) {
      await client.query(stmt);
    }
  } finally {
    await client.end();
  }
}

// Run only when invoked as the entrypoint (node dist/migrate.js), not when imported.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(
    () => {
      console.log(`migrate: applied schema "${PLATFORM_POLICY.databaseSchema}"`);
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : `migrate: ${String(err)}`);
      process.exitCode = 1;
    },
  );
}
