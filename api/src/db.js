import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS dm_conversations (
    id SERIAL PRIMARY KEY,
    user_one_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_two_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dm_distinct_users CHECK (user_one_id < user_two_id),
    CONSTRAINT dm_unique_pair UNIQUE (user_one_id, user_two_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    body TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT message_single_destination CHECK (
      (room_id IS NOT NULL AND conversation_id IS NULL) OR
      (room_id IS NULL AND conversation_id IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS messages_room_page_idx
    ON messages (room_id, id DESC) WHERE room_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_dm_page_idx
    ON messages (conversation_id, id DESC) WHERE conversation_id IS NOT NULL;
`;

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(73918421)');
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(73918421)').catch(() => {});
    client.release();
  }
}

export async function waitForDatabase(attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}
