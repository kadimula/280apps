// Test support for the store suite: a fresh, empty Postgres schema per test.
//
// Isolation is a Postgres schema per call rather than a database per call: same
// dialect and same migrations as production, which is the entire reason the
// suite is not run against SQLite. Mirrors platform/conformance_test.go newStore.
//
// Without TEST_DATABASE_URL the store tests skip, which is a local convenience.
// Skipping in CI would turn the suite into a green check that asserts nothing,
// so there it is fatal instead.

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

// newStore returns an empty database confined to its own schema, and registers
// its teardown (drop schema, close pool) on the returned handle. Open creates
// the schema, which is the same path production takes on its first boot;
// dropping it is the test's job.
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
