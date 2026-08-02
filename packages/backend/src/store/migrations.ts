// The control-plane schema in one place, imported by both the store's boot migrate
// (store.ts `open`) and the standalone CI runner (../migrate.ts). Every statement
// is schema-qualified and idempotent: a session `search_path` does not survive
// transaction-mode pooling (Hyperdrive drops it between checkouts), so nothing may
// depend on session state, and re-applying to a migrated schema is a no-op.

// The shape of a bare Postgres identifier. A schema name reaches SQL by
// concatenation (an identifier cannot be a bind parameter) and arrives from the
// environment, so it is checked rather than trusted.
export const safeSchema = /^[a-z_][a-z0-9_]*$/;

export type Qualifier = (name: string) => string;

// A table-name qualifier bound to one schema, validated once here so every caller
// interpolating its result is interpolating a proven-safe value. Empty schema
// yields bare names (the public schema), matching the pre-schema behaviour.
export function qualify(schema: string): Qualifier {
  if (schema !== '' && !safeSchema.test(schema)) {
    throw new Error(`store: "${schema}" is not a valid schema name`);
  }
  const prefix = schema === '' ? '' : `"${schema}".`;
  return (name: string) => `${prefix}"${name}"`;
}

// The created_at default. Seconds since the epoch rather than a timestamptz
// because these columns are only read as ordering keys and compared to Date.now()/1000.
const epochDefault = `EXTRACT(EPOCH FROM now())::bigint`;

// The ordered, idempotent statement list for one schema. A non-empty schema is
// created first: the platform owns its own tables, and needing a DBA to run one
// DDL statement before the first boot is a step that gets forgotten.
export function migrations(schema: string): string[] {
  const t = qualify(schema);
  // information_schema keys tables by their real schema; empty schema is public.
  const schemaLit = schema === '' ? 'public' : schema;
  const stmts: string[] = [];

  if (schema !== '') {
    stmts.push(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  }

  stmts.push(
    // One-time, idempotent carry-over of the legacy accounts indirection into the
    // merged user-as-principal model. Runs only while the accounts table still
    // exists in this schema (a no-op once it has been dropped, so re-runs converge;
    // a no-op on a fresh schema, where the branch is never entered). It must precede
    // every user_id table and index below: CREATE INDEX IF NOT EXISTS validates its
    // column list before the name-skip, so an index over user_id would fail on a
    // legacy schema whose column is still account_id until this rename.
    `DO $$
     DECLARE orphan_count bigint;
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = '${schemaLit}' AND table_name = 'accounts'
       ) THEN
         SELECT count(*) INTO orphan_count FROM ${t('accounts')} WHERE subject = '';
         IF orphan_count > 0 THEN
           RAISE EXCEPTION 'accounts merge: % account row(s) have an empty subject and cannot be mapped to a user; delete or map them manually, then re-run the migration', orphan_count;
         END IF;

         IF EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = '${schemaLit}' AND table_name = 'apps' AND column_name = 'account_id') THEN
           UPDATE ${t('apps')} ap SET account_id = a.subject FROM ${t('accounts')} a WHERE a.id = ap.account_id;
           ALTER TABLE ${t('apps')} RENAME COLUMN account_id TO user_id;
         END IF;
         IF EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = '${schemaLit}' AND table_name = 'tokens' AND column_name = 'account_id') THEN
           UPDATE ${t('tokens')} tk SET account_id = a.subject FROM ${t('accounts')} a WHERE a.id = tk.account_id;
           ALTER TABLE ${t('tokens')} RENAME COLUMN account_id TO user_id;
         END IF;
         IF EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = '${schemaLit}' AND table_name = 'device_codes' AND column_name = 'account_id') THEN
           UPDATE ${t('device_codes')} dc SET account_id = a.subject FROM ${t('accounts')} a WHERE a.id = dc.account_id;
           ALTER TABLE ${t('device_codes')} RENAME COLUMN account_id TO user_id;
         END IF;
         IF EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = '${schemaLit}' AND table_name = 'events' AND column_name = 'account_id') THEN
           UPDATE ${t('events')} ev SET account_id = a.subject FROM ${t('accounts')} a WHERE a.id = ev.account_id;
           ALTER TABLE ${t('events')} RENAME COLUMN account_id TO user_id;
         END IF;

         ALTER INDEX IF EXISTS ${t('events_by_account')} RENAME TO events_by_user;
         DROP TABLE ${t('accounts')};
       END IF;
     END $$`,

    // Only the hash is stored, so a leaked database does not hand over the ability
    // to push to every user in it.
    `CREATE TABLE IF NOT EXISTS ${t('tokens')} (
       token_hash TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL,
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE TABLE IF NOT EXISTS ${t('device_codes')} (
       device_hash TEXT PRIMARY KEY,
       user_code   TEXT NOT NULL UNIQUE,
       user_id     TEXT NOT NULL DEFAULT '',
       status      TEXT NOT NULL,
       expires_at  BIGINT NOT NULL,
       created_at  BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE TABLE IF NOT EXISTS ${t('apps')} (
       id            TEXT PRIMARY KEY,
       user_id       TEXT NOT NULL,
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
    `CREATE INDEX IF NOT EXISTS apps_by_fingerprint ON ${t('apps')}(user_id, fingerprint)`,
    // Enforces clientRef create-dedup in the database rather than a read-then-write
    // race: a retried push that lost its config file cannot produce a second app.
    `CREATE UNIQUE INDEX IF NOT EXISTS apps_by_client_ref
       ON ${t('apps')}(user_id, client_ref) WHERE client_ref <> ''`,
    `CREATE TABLE IF NOT EXISTS ${t('deploys')} (
       app_id     TEXT NOT NULL,
       id         TEXT NOT NULL,
       manifest   TEXT NOT NULL,
       state      TEXT NOT NULL,
       failure    TEXT NOT NULL DEFAULT '',
       created_at BIGINT NOT NULL DEFAULT (${epochDefault}),
       PRIMARY KEY (app_id, id)
     )`,
    // Append-only. A serial id because the useful order is when things happened and
    // two events can share a second; scoping columns default '' so reads are plain equality.
    `CREATE TABLE IF NOT EXISTS ${t('events')} (
       id         BIGSERIAL PRIMARY KEY,
       user_id    TEXT NOT NULL DEFAULT '',
       app_id     TEXT NOT NULL DEFAULT '',
       deploy_id  TEXT NOT NULL DEFAULT '',
       kind       TEXT NOT NULL,
       detail     TEXT NOT NULL DEFAULT '',
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE INDEX IF NOT EXISTS events_by_time ON ${t('events')}(created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS events_by_user ON ${t('events')}(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS events_by_app ON ${t('events')}(app_id, created_at DESC)`,

    // The two-tier permission model, flat: one row per (app, principal), no
    // relationship graph. app_role is tier 1, feature_role tier 2 (plain TEXT, no
    // CHECK: the seam's AppRole is the contract). Optional columns default '' so
    // reads are plain equality; PRIMARY KEY (app_id, principal) is also the index a
    // per-app listing scans, so no separate index is needed.
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

    // The enforced slice of a live deploy's manifest (design §5.1 "Manifest
    // registered → D1"): access mode, feature-role vocabulary, route gates, declared
    // secret names, and the owner's tenant. One row per app, replaced whenever a
    // deploy goes live. The gateway reads it per request to gate routes; the share
    // dialog reads roles to offer them. JSON columns default '' so a bad decode is a
    // safe empty, not a broken row.
    `CREATE TABLE IF NOT EXISTS ${t('app_policies')} (
       app_id       TEXT PRIMARY KEY,
       access       TEXT NOT NULL DEFAULT 'invited',
       roles        TEXT NOT NULL DEFAULT '',
       routes       TEXT NOT NULL DEFAULT '',
       secrets      TEXT NOT NULL DEFAULT '',
       owner_tenant TEXT NOT NULL DEFAULT '',
       updated_at   BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,

    // Identity the backend now owns since login moved off the frontend. A user's id
    // is the OIDC-stable principal every resource keys on (assigned once, never
    // changes); email is lowercased and unique so two providers for one person converge.
    `CREATE TABLE IF NOT EXISTS ${t('users')} (
       id         TEXT PRIMARY KEY,
       email      TEXT NOT NULL,
       name       TEXT NOT NULL DEFAULT '',
       image      TEXT NOT NULL DEFAULT '',
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_by_email ON ${t('users')}(email)`,
    // The provider's handle for the user is the key, so a returning Google user
    // resolves to the same id every time.
    `CREATE TABLE IF NOT EXISTS ${t('oauth_accounts')} (
       provider            TEXT NOT NULL,
       provider_account_id TEXT NOT NULL,
       user_id             TEXT NOT NULL,
       created_at          BIGINT NOT NULL DEFAULT (${epochDefault}),
       PRIMARY KEY (provider, provider_account_id)
     )`,
    `CREATE INDEX IF NOT EXISTS oauth_by_user ON ${t('oauth_accounts')}(user_id)`,
    // Only the token hash is stored, mirroring tokens above.
    `CREATE TABLE IF NOT EXISTS ${t('sessions')} (
       token_hash TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL,
       expires_at BIGINT NOT NULL,
       created_at BIGINT NOT NULL DEFAULT (${epochDefault})
     )`,
    `CREATE INDEX IF NOT EXISTS sessions_by_user ON ${t('sessions')}(user_id)`,
    // One row per key (a client IP). expires_at is the end of the current window,
    // so read and increment compare against now with no interval arithmetic.
    `CREATE TABLE IF NOT EXISTS ${t('login_rate_limits')} (
       key        TEXT PRIMARY KEY,
       count      BIGINT NOT NULL DEFAULT 0,
       expires_at BIGINT NOT NULL
     )`,

    // One-time, idempotent carry-over of the next-auth tables the frontend used to
    // own (a no-op when they are absent). Copies id/email/name/image and the Google
    // linkage; passwords are left behind since login is now OIDC-only, and a migrated
    // user signs in with Google on the same email and lands on their original id. The
    // legacy tables live in the public schema, so this runs from a plain connection.
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
