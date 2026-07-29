// migrate: the standalone control-plane migration runner. CI runs this once,
// before a deploy, against the database directly. It applies the same shared,
// idempotent statement list the store applies on boot (store/migrations.ts), so
// the two paths cannot drift.
//
// Direct, never through Hyperdrive. A migration opens one plain connection to
// the primary and runs DDL; routing that through a transaction-mode pooler
// (which drops session state and multiplexes connections) is the one thing DDL
// must not do. This runner reads a direct DSN and is only ever invoked from CI.
//
// Deliberately not reachable at runtime. There is no admin route and no
// first-request migrate: a standing endpoint that runs DDL is attack surface.
// The only trigger is CI invoking this script (`pnpm --filter @280/backend
// migrate`, i.e. `node dist/migrate.js`).

import pg from 'pg';
import { migrations } from './store/migrations.js';

const { Client } = pg;

// dsn is the direct database URL. MIGRATE_DATABASE_URL wins when set, so CI can
// point the runner at the primary even in an environment whose DATABASE_URL is
// a pooled/Hyperdrive endpoint; otherwise DATABASE_URL, matching the server.
function dsn(): string {
  return process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
}

// schema mirrors main.ts: the platform's tables live in their own schema,
// defaulting to "platform".
function schema(): string {
  const s = process.env.TWO80_DB_SCHEMA;
  return s === undefined || s === '' ? 'platform' : s;
}

export async function migrate(): Promise<void> {
  const url = dsn();
  if (url === '') {
    throw new Error('migrate: set MIGRATE_DATABASE_URL or DATABASE_URL');
  }
  // migrations() validates the schema and throws on a bad identifier before any
  // connection is opened.
  const stmts = migrations(schema());

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

// Run when invoked as the entrypoint (node dist/migrate.js), not when imported.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(
    () => {
      console.log(`migrate: applied schema "${schema()}"`);
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : `migrate: ${String(err)}`);
      process.exitCode = 1;
    },
  );
}
