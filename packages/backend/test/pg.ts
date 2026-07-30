// Test support for the store suite: a fresh, empty Postgres schema per test.
//
// Isolation is a schema per call, not a database per call: same dialect and
// migrations as production, which is why the suite is not run against SQLite.
//
// Without TEST_DATABASE_URL the store tests skip (a local convenience). In CI
// that would be a green check asserting nothing, so there it is fatal instead.

import pg from 'pg';
import { open } from '../src/store/store.js';
import type { Store } from '../src/seams.js';

const { Client } = pg;

export function testDatabaseURL(): string {
  return process.env.TEST_DATABASE_URL ?? '';
}

export function requireDatabaseURL(): string {
  const base = testDatabaseURL();
  if (base === '') {
    if (process.env.CI) {
      throw new Error('TEST_DATABASE_URL is unset in CI');
    }
    // Signals the caller to skip; see newStore.
    return '';
  }
  return base;
}

let schemaSeq = 0;

// returns an empty database confined to its own schema, plus its teardown (drop
// schema, close pool). open() creates the schema, the same path production takes
// on first boot; dropping it is the test's job.
export async function newStore(): Promise<{ store: Store; cleanup: () => Promise<void> }> {
  const base = requireDatabaseURL();
  if (base === '') {
    throw new Error('newStore called without TEST_DATABASE_URL; guard with hasDatabase()');
  }
  const name = `t_${process.pid}_${++schemaSeq}`;
  const store = await open(base, name);
  const cleanup = async () => {
    await store.close();
    const admin = new Client({ connectionString: base });
    try {
      await admin.connect();
      await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    } catch {
      // best effort teardown
    } finally {
      await admin.end().catch(() => {});
    }
  };
  return { store, cleanup };
}

export function hasDatabase(): boolean {
  return requireDatabaseURL() !== '';
}
