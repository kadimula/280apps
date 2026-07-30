// The control-plane schema, in one place. Both the store's boot migrate
// (store.ts `open`) and the standalone CI runner (../migrate.ts) import this
// module, so the tables a fresh boot creates and the tables CI provisions
// before a deploy are the same statements, applied the same way.
//
// Every statement is schema-qualified rather than relying on `search_path`.
// A session `search_path` does not survive transaction-mode connection pooling
// (Hyperdrive drops it between checkouts), so no statement here — or in the
// store — may depend on session or connection state. The schema name is
// validated (safeSchema) and interpolated through one qualifier; it cannot be
// a bind parameter because an identifier never can.
//
// Each statement stands alone and is idempotent, so applying them to an
// already-migrated schema is a no-op rather than a version check to keep in
// sync. Verbatim from store.go:131 (same tables, same partial unique indexes),
// with schema qualification added.

// safeSchema is the shape of a bare Postgres identifier. A schema name reaches
// SQL by concatenation, since an identifier cannot be a bind parameter, so the
// value is checked rather than trusted — it arrives from the environment.
export const safeSchema = /^[a-z_][a-z0-9_]*$/;

// Qualifier maps a bare table name to its addressable form.
export type Qualifier = (name: string) => string;

// qualify returns a table-name qualifier bound to one schema. A non-empty
// schema is validated once here, so every caller interpolating its result is
// interpolating a value already proven safe. An empty schema yields bare names
// (the public schema), matching the pre-schema behaviour.
export function qualify(schema: string): Qualifier {
  if (schema !== '' && !safeSchema.test(schema)) {
    throw new Error(`store: "${schema}" is not a valid schema name`);
  }
  const prefix = schema === '' ? '' : `"${schema}".`;
  return (name: string) => `${prefix}"${name}"`;
}

// epochDefault is the created_at default. Seconds since the epoch rather than a
// timestamptz because these columns are only ever read as ordering keys and
// compared against Date.now()/1000.
const epochDefault = `EXTRACT(EPOCH FROM now())::bigint`;

// migrations is the ordered, idempotent statement list for one schema. A
// non-empty schema is created first: the platform owns its own tables, and
// needing a DBA to run one DDL statement before the first boot is a step that
// gets forgotten. Everything after addresses tables through the qualifier, so
// nothing depends on `search_path`.
export function migrations(schema: string): string[] {
  const t = qualify(schema);
  const stmts: string[] = [];

  if (schema !== '') {
    stmts.push(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  }

  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${t('accounts')} (
       id         TEXT PRIMARY KEY,
       subject    TEXT NOT NULL DEFAULT '',
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    // One account per identity. Partial, so the subject-less accounts OpenSignup
    // mints do not all collide on ''.
    `CREATE UNIQUE INDEX IF NOT EXISTS accounts_by_subject
       ON ${t('accounts')}(subject) WHERE subject <> ''`,
    // Only the hash is stored, so a leaked database does not hand over the ability
    // to push to every account in it.
    `CREATE TABLE IF NOT EXISTS ${t('tokens')} (
       token_hash TEXT PRIMARY KEY,
       account_id TEXT NOT NULL,
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE TABLE IF NOT EXISTS ${t('device_codes')} (
       device_hash TEXT PRIMARY KEY,
       user_code   TEXT NOT NULL UNIQUE,
       account_id  TEXT NOT NULL DEFAULT '',
       status      TEXT NOT NULL,
       expires_at  BIGINT NOT NULL,
       created_at  BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE TABLE IF NOT EXISTS ${t('apps')} (
       id            TEXT PRIMARY KEY,
       account_id    TEXT NOT NULL,
       slug          TEXT NOT NULL,
       framework     TEXT NOT NULL,
       url           TEXT NOT NULL,
       script        TEXT NOT NULL UNIQUE,
       salt          TEXT NOT NULL,
       fingerprint   TEXT NOT NULL DEFAULT '',
       client_ref    TEXT NOT NULL DEFAULT '',
       store_id      TEXT NOT NULL DEFAULT '',
       active_deploy TEXT NOT NULL DEFAULT '',
       created_at    BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE INDEX IF NOT EXISTS apps_by_fingerprint ON ${t('apps')}(account_id, fingerprint)`,
    // Enforces clientRef create-dedup in the database rather than in a
    // read-then-write race: a retried push that lost its config file cannot
    // produce a second app.
    `CREATE UNIQUE INDEX IF NOT EXISTS apps_by_client_ref
       ON ${t('apps')}(account_id, client_ref) WHERE client_ref <> ''`,
    `CREATE TABLE IF NOT EXISTS ${t('deploys')} (
       app_id     TEXT NOT NULL,
       id         TEXT NOT NULL,
       manifest   TEXT NOT NULL,
       state      TEXT NOT NULL,
       failure    TEXT NOT NULL DEFAULT '',
       created_at BIGINT NOT NULL DEFAULT (${epochDefault}),
       PRIMARY KEY (app_id, id)
     )`,
    // Append-only. A serial id rather than a natural key because the useful order
    // is the order things happened, and two events can share a second. The
    // scoping columns default to '' rather than NULL so every read is a plain
    // equality test.
    `CREATE TABLE IF NOT EXISTS ${t('events')} (
       id         BIGSERIAL PRIMARY KEY,
       account_id TEXT NOT NULL DEFAULT '',
       app_id     TEXT NOT NULL DEFAULT '',
       deploy_id  TEXT NOT NULL DEFAULT '',
       kind       TEXT NOT NULL,
       detail     TEXT NOT NULL DEFAULT '',
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE INDEX IF NOT EXISTS events_by_time ON ${t('events')}(created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS events_by_account ON ${t('events')}(account_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS events_by_app ON ${t('events')}(app_id, created_at DESC)`,

    // Sharing grants: the two-tier permission model (design §5.4), flat — one row
    // per (app, principal), no OpenFGA and no relationship graph. app_role is
    // tier 1, the app as an object (owner|admin|editor|viewer, plain TEXT like
    // device_codes.status, no CHECK — the seam's AppRole is the contract).
    // feature_role is tier 2, a builder-defined role name from the app's 280.json;
    // custom actions fold into it via can() rather than a separate concept. The
    // optional text columns default to '' rather than NULL so every read is a
    // plain equality test, matching the events scoping columns above; data_scope
    // holds advisory JSON (or ''). The PRIMARY KEY (app_id, principal) is also the
    // index a per-app listing scans, so no separate index is needed. No tenants
    // table: a principal is a self-describing email or 'domain:' string, so grants
    // key on (app_id, principal) alone and need no tenant row to be coherent —
    // that stays out of this slice until relationships turn graph-shaped.
    `CREATE TABLE IF NOT EXISTS ${t('grants')} (
       app_id       TEXT NOT NULL,
       principal    TEXT NOT NULL,
       app_role     TEXT NOT NULL,
       feature_role TEXT NOT NULL DEFAULT '',
       data_scope   TEXT NOT NULL DEFAULT '',
       granted_by   TEXT NOT NULL DEFAULT '',
       granted_at   BIGINT NOT NULL DEFAULT (${epochDefault}),
       PRIMARY KEY (app_id, principal)
     )`,

    // Identity the backend now owns, since login moved off the frontend. A user's
    // id is the subject the accounts table keys on, so it is assigned once and
    // never changes; email is lowercased and unique so two providers for one
    // person converge on one user.
    `CREATE TABLE IF NOT EXISTS ${t('users')} (
       id         TEXT PRIMARY KEY,
       email      TEXT NOT NULL,
       name       TEXT NOT NULL DEFAULT '',
       image      TEXT NOT NULL DEFAULT '',
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_by_email ON ${t('users')}(email)`,
    // One row per external login. The provider's handle for the user is the key,
    // so a returning Google user resolves to the same id every time.
    `CREATE TABLE IF NOT EXISTS ${t('oauth_accounts')} (
       provider            TEXT NOT NULL,
       provider_account_id TEXT NOT NULL,
       user_id             TEXT NOT NULL,
       created_at          BIGINT NOT NULL DEFAULT (${epochDefault}),
       PRIMARY KEY (provider, provider_account_id)
     )`,
    `CREATE INDEX IF NOT EXISTS oauth_by_user ON ${t('oauth_accounts')}(user_id)`,
    // Browser sessions. Only the token hash is stored, mirroring tokens above.
    `CREATE TABLE IF NOT EXISTS ${t('sessions')} (
       token_hash TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL,
       expires_at BIGINT NOT NULL,
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE INDEX IF NOT EXISTS sessions_by_user ON ${t('sessions')}(user_id)`,
    // Login rate counters, one row per key (a client IP). expires_at is the end of
    // the current window, so both read and increment compare against now with no
    // interval arithmetic.
    `CREATE TABLE IF NOT EXISTS ${t('login_rate_limits')} (
       key        TEXT PRIMARY KEY,
       count      BIGINT NOT NULL DEFAULT 0,
       expires_at BIGINT NOT NULL
     )`,

    // One-time carry-over of the next-auth tables the frontend used to own. It is
    // idempotent (NOT EXISTS guards on both id and email) and a no-op when those
    // tables are absent, so it is safe to leave in the boot migration set: a fresh
    // database simply skips it. It copies id/email/name/image and the Google
    // account linkage; passwords are intentionally left behind, since login is now
    // OIDC-only and a migrated password user signs in with Google on the same
    // email and lands on their original id. The legacy tables live in the public
    // schema (the frontend set no search_path); this platform's tables are
    // addressed explicitly, so this block runs unchanged from a plain connection.
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'user'
       ) THEN
         INSERT INTO ${t('users')} (id, email, name, image)
         SELECT u.id, lower(u.email), COALESCE(u.name, ''), COALESCE(u.image, '')
         FROM public."user" u
         WHERE u.email IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM ${t('users')} x WHERE x.id = u.id OR x.email = lower(u.email)
           );

         IF EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'account'
         ) THEN
           INSERT INTO ${t('oauth_accounts')} (provider, provider_account_id, user_id)
           SELECT a.provider, a."providerAccountId", a."userId"
           FROM public."account" a
           WHERE a.provider = 'google'
             AND EXISTS (SELECT 1 FROM ${t('users')} u WHERE u.id = a."userId")
           ON CONFLICT (provider, provider_account_id) DO NOTHING;
         END IF;
       END IF;
     END $$`,
  );

  return stmts;
}
