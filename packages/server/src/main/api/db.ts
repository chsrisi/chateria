import pg from 'pg';

const { Pool } = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * Postgres hands back BIGINT (OID 20) as a string to avoid precision loss.
 * Message ids are BIGSERIAL but will not realistically pass 2^53, and every
 * id crossing the wire is typed `number`, so parse them once here rather than
 * sprinkling Number() through the query layer.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

const MIGRATION_LOCK_ID = 73_918_421;

/**
 * The whole schema, applied idempotently on every start inside an advisory
 * lock so that two server instances pointed at one database cannot race.
 * Statements must stay backwards compatible: existing tables are never
 * rewritten by this, only created if absent.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS dm_conversations (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_one_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_two_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dm_distinct_users CHECK (user_one_id < user_two_id),
    CONSTRAINT dm_unique_pair UNIQUE (user_one_id, user_two_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    body TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT message_single_destination CHECK (num_nonnulls(room_id, conversation_id) = 1)
  );

  CREATE INDEX IF NOT EXISTS messages_room_page_idx
    ON messages (room_id, id DESC) WHERE room_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_dm_page_idx
    ON messages (conversation_id, id DESC) WHERE conversation_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id);
`;

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await client.query('BEGIN');
      await client.query(SCHEMA);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

export async function waitForDatabase(
  pool: Pool,
  { attempts = 30, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export async function serverVersion(pool: Pool): Promise<string> {
  // SHOW names its column after the setting, so select it explicitly instead.
  const result = await pool.query<{ version: string }>(
    "SELECT current_setting('server_version') AS version",
  );
  return result.rows[0]?.version ?? 'unknown';
}
