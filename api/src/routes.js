import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { authRequired, createToken } from './auth.js';
import { messageFromRow, pagination, parsePositiveId } from './format.js';

const router = express.Router();
const USERNAME_MAX = 64;
const PASSWORD_MAX = 1024;

function credentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || username.length > USERNAME_MAX || !password || password.length > PASSWORD_MAX) return null;
  return { username, password };
}

router.post('/auth/register', async (req, res, next) => {
  try {
    const input = credentials(req.body);
    if (!input) return res.status(400).json({ error: 'A valid username and password are required' });
    const passwordHash = await bcrypt.hash(input.password, 12);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [input.username, passwordHash],
    );
    const user = { id: Number(result.rows[0].id), username: result.rows[0].username };
    return res.status(201).json({ token: createToken(user), user });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    return next(error);
  }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    const input = credentials(req.body);
    if (!input) return res.status(400).json({ error: 'A valid username and password are required' });
    const result = await pool.query('SELECT id, username, password_hash FROM users WHERE username = $1', [input.username]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(input.password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = { id: Number(row.id), username: row.username };
    return res.json({ token: createToken(user), user });
  } catch (error) {
    return next(error);
  }
});

router.use(authRequired);

router.get('/me', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT id, username FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    return res.json({ id: Number(result.rows[0].id), username: result.rows[0].username });
  } catch (error) {
    return next(error);
  }
});

router.get('/rooms', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT r.id, r.name, COUNT(rm.user_id)::int AS member_count
      FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id
      GROUP BY r.id ORDER BY r.id
    `);
    return res.json(result.rows.map((row) => ({
      id: Number(row.id), name: row.name, memberCount: Number(row.member_count),
    })));
  } catch (error) {
    return next(error);
  }
});

router.post('/rooms', async (req, res, next) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) return res.status(400).json({ error: 'Room name is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(
      'INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id, name', [name, req.user.id],
    );
    await client.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [roomResult.rows[0].id, req.user.id]);
    await client.query('COMMIT');
    return res.status(201).json({ id: Number(roomResult.rows[0].id), name: roomResult.rows[0].name });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/rooms/:id/join', async (req, res, next) => {
  const roomId = parsePositiveId(req.params.id);
  if (!roomId) return res.status(400).json({ error: 'Invalid room id' });
  try {
    const room = await pool.query('SELECT 1 FROM rooms WHERE id = $1', [roomId]);
    if (!room.rowCount) return res.status(404).json({ error: 'Room not found' });
    await pool.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roomId, req.user.id]);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

router.post('/rooms/:id/leave', async (req, res, next) => {
  const roomId = parsePositiveId(req.params.id);
  if (!roomId) return res.status(400).json({ error: 'Invalid room id' });
  try {
    const room = await pool.query('SELECT 1 FROM rooms WHERE id = $1', [roomId]);
    if (!room.rowCount) return res.status(404).json({ error: 'Room not found' });
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, req.user.id]);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

async function memberOfRoom(roomId, userId) {
  const result = await pool.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  return result.rowCount > 0;
}

async function dmParticipant(conversationId, userId) {
  const result = await pool.query(
    'SELECT 1 FROM dm_conversations WHERE id = $1 AND (user_one_id = $2 OR user_two_id = $2)',
    [conversationId, userId],
  );
  return result.rowCount > 0;
}

async function messagePage(column, destinationId, query, res, next) {
  const page = pagination(query);
  if (page.invalidBefore) return res.status(400).json({ error: 'Invalid cursor' });
  try {
    const result = await pool.query(`
      SELECT m.*, u.username AS author_username
      FROM messages m JOIN users u ON u.id = m.author_id
      WHERE m.${column} = $1 AND ($2::bigint IS NULL OR m.id < $2)
      ORDER BY m.id DESC LIMIT $3
    `, [destinationId, page.before, page.limit + 1]);
    const hasMore = result.rows.length > page.limit;
    const selected = result.rows.slice(0, page.limit).reverse().map(messageFromRow);
    return res.json({ messages: selected, nextCursor: hasMore && selected.length ? selected[0].id : null });
  } catch (error) {
    return next(error);
  }
}

router.get('/rooms/:id/messages', async (req, res, next) => {
  const roomId = parsePositiveId(req.params.id);
  if (!roomId) return res.status(400).json({ error: 'Invalid room id' });
  try {
    const room = await pool.query('SELECT 1 FROM rooms WHERE id = $1', [roomId]);
    if (!room.rowCount) return res.status(404).json({ error: 'Room not found' });
    if (!(await memberOfRoom(roomId, req.user.id))) return res.status(403).json({ error: 'Join the room to read its messages' });
    return messagePage('room_id', roomId, req.query, res, next);
  } catch (error) {
    return next(error);
  }
});

router.get('/dms', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT d.id,
        CASE WHEN d.user_one_id = $1 THEN u2.id ELSE u1.id END AS other_id,
        CASE WHEN d.user_one_id = $1 THEN u2.username ELSE u1.username END AS other_username,
        lm.id AS message_id, lm.body, lm.author_id, lm.created_at, lm.room_id, lm.conversation_id,
        au.username AS author_username
      FROM dm_conversations d
      JOIN users u1 ON u1.id = d.user_one_id
      JOIN users u2 ON u2.id = d.user_two_id
      LEFT JOIN LATERAL (
        SELECT * FROM messages m WHERE m.conversation_id = d.id ORDER BY m.id DESC LIMIT 1
      ) lm ON TRUE
      LEFT JOIN users au ON au.id = lm.author_id
      WHERE d.user_one_id = $1 OR d.user_two_id = $1
      ORDER BY lm.id DESC NULLS LAST, d.id DESC
    `, [req.user.id]);
    return res.json(result.rows.map((row) => ({
      conversationId: Number(row.id),
      otherUser: { id: Number(row.other_id), username: row.other_username },
      lastMessage: row.message_id == null ? null : messageFromRow({ ...row, id: row.message_id }),
    })));
  } catch (error) {
    return next(error);
  }
});

router.post('/dms', async (req, res, next) => {
  const otherId = parsePositiveId(req.body?.userId);
  if (!otherId) return res.status(400).json({ error: 'Valid userId is required' });
  if (otherId === req.user.id) return res.status(400).json({ error: 'Cannot create a DM with yourself' });
  try {
    const user = await pool.query('SELECT 1 FROM users WHERE id = $1', [otherId]);
    if (!user.rowCount) return res.status(404).json({ error: 'User not found' });
    const first = Math.min(req.user.id, otherId);
    const second = Math.max(req.user.id, otherId);
    const result = await pool.query(`
      INSERT INTO dm_conversations (user_one_id, user_two_id) VALUES ($1, $2)
      ON CONFLICT (user_one_id, user_two_id)
      DO UPDATE SET user_one_id = EXCLUDED.user_one_id
      RETURNING id
    `, [first, second]);
    return res.status(201).json({ conversationId: Number(result.rows[0].id) });
  } catch (error) {
    return next(error);
  }
});

router.get('/dms/:id/messages', async (req, res, next) => {
  const conversationId = parsePositiveId(req.params.id);
  if (!conversationId) return res.status(400).json({ error: 'Invalid conversation id' });
  try {
    const exists = await pool.query('SELECT 1 FROM dm_conversations WHERE id = $1', [conversationId]);
    if (!exists.rowCount) return res.status(404).json({ error: 'Conversation not found' });
    if (!(await dmParticipant(conversationId, req.user.id))) return res.status(403).json({ error: 'Not a participant' });
    return messagePage('conversation_id', conversationId, req.query, res, next);
  } catch (error) {
    return next(error);
  }
});

router.get('/users', async (req, res, next) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  try {
    const result = await pool.query(
      `SELECT id, username FROM users
       WHERE id <> $1 AND ($2 = '' OR username ILIKE '%' || $2 || '%')
       ORDER BY username LIMIT 50`,
      [req.user.id, q],
    );
    return res.json(result.rows.map((row) => ({ id: Number(row.id), username: row.username })));
  } catch (error) {
    return next(error);
  }
});

export function createRouter(presence) {
  router.get('/presence', async (_req, res, next) => {
    try {
      const result = await pool.query('SELECT id FROM users ORDER BY id');
      return res.json(result.rows.map((row) => ({
        userId: Number(row.id), status: presence.isOnline(Number(row.id)) ? 'online' : 'offline',
      })));
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

export { memberOfRoom, dmParticipant };
