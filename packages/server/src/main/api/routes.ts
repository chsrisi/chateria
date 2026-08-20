import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AuthResult, ServerInfo } from '@chateria/protocol';
import { PROTOCOL_VERSION } from '@chateria/protocol';
import { bearerToken, createToken, hashPassword, verifyPassword, verifyToken } from './auth.ts';
import type { ApiConfig } from './config.ts';
import { ttlToSeconds } from './config.ts';
import type { Pool } from './db.ts';
import { pagination, parsePositiveId } from './format.ts';
import { createDmSchema, createRoomSchema, credentialsSchema } from './frames.ts';
import { JWT_ALG, type SigningKeys } from './keys.ts';
import type { Hub } from './realtime.ts';
import {
  dmParticipant,
  findDm,
  findRoom,
  findUser,
  listDms,
  listRooms,
  memberOfRoom,
  messagePage,
  roomMemberCount,
} from './queries.ts';

export interface RouterDeps {
  pool: Pool;
  keys: SigningKeys;
  hub: Hub;
  config: ApiConfig;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: number; username: string };
    }
  }
}

const UNIQUE_VIOLATION = '23505';

export function createRouter({ pool, keys, hub, config }: RouterDeps): Router {
  const router = Router();
  const ttlSeconds = ttlToSeconds(config.tokenTtl);

  async function issue(user: { id: number; username: string }): Promise<AuthResult> {
    return {
      token: await createToken(user, keys, config.tokenTtl),
      user,
      expiresIn: ttlSeconds,
    };
  }

  /* ---------------- public ---------------- */

  router.get('/info', (_req, res) => {
    const info: ServerInfo = {
      name: 'chateria',
      protocolVersion: PROTOCOL_VERSION,
      maxMessageLength: config.maxMessageLength,
      algorithm: JWT_ALG,
    };
    res.json(info);
  });

  router.post('/auth/register', async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'A valid username and password are required' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const result = await pool.query<{ id: number; username: string }>(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [parsed.data.username, passwordHash],
      );
      const row = result.rows[0]!;
      const user = { id: Number(row.id), username: row.username };

      // Everyone's "people" list gains a row, so tell the connected clients.
      hub.toAll({ type: 'user:registered', user });
      return res.status(201).json(await issue(user));
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      throw error;
    }
  });

  router.post('/auth/login', async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'A valid username and password are required' });
    }

    const result = await pool.query<{ id: number; username: string; password_hash: string }>(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [parsed.data.username],
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(parsed.data.password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    return res.json(await issue({ id: Number(row.id), username: row.username }));
  });

  /* ---------------- authenticated ---------------- */

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const token = bearerToken(req.get('authorization'));
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      req.user = await verifyToken(token, keys);
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  router.get('/me', async (req, res) => {
    const user = await findUser(pool, req.user!.id);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    return res.json(user);
  });

  router.get('/rooms', async (req, res) => {
    res.json(await listRooms(pool, req.user!.id));
  });

  router.post('/rooms', async (req, res) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Room name is required' });

    const creator = req.user!;
    const client = await pool.connect();
    let roomId: number;
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: number }>(
        'INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id',
        [parsed.data.name, creator.id],
      );
      roomId = Number(inserted.rows[0]!.id);
      await client.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [
        roomId,
        creator.id,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const room = { id: roomId, name: parsed.data.name, memberCount: 1 };
    // The room list is public to authenticated users, so this goes to everyone.
    hub.toAll({ type: 'room:created', room, createdBy: creator });
    return res.status(201).json({ ...room, joined: true });
  });

  router.post('/rooms/:id/join', async (req, res) => {
    const roomId = parsePositiveId(req.params.id);
    if (!roomId) return res.status(400).json({ error: 'Invalid room id' });

    const room = await findRoom(pool, roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const inserted = await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [roomId, req.user!.id],
    );

    // Joining is idempotent, but only a real membership change is worth a broadcast.
    if (inserted.rowCount! > 0) {
      hub.toAll({
        type: 'room:member_joined',
        roomId,
        user: req.user!,
        memberCount: await roomMemberCount(pool, roomId),
      });
    }
    return res.status(204).end();
  });

  router.post('/rooms/:id/leave', async (req, res) => {
    const roomId = parsePositiveId(req.params.id);
    if (!roomId) return res.status(400).json({ error: 'Invalid room id' });

    const room = await findRoom(pool, roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const deleted = await pool.query(
      'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, req.user!.id],
    );

    if (deleted.rowCount! > 0) {
      hub.toAll({
        type: 'room:member_left',
        roomId,
        userId: req.user!.id,
        memberCount: await roomMemberCount(pool, roomId),
      });
    }
    return res.status(204).end();
  });

  router.get('/rooms/:id/messages', async (req, res) => {
    const roomId = parsePositiveId(req.params.id);
    if (!roomId) return res.status(400).json({ error: 'Invalid room id' });

    const page = pagination(req.query as Record<string, unknown>);
    if (page.invalidBefore) return res.status(400).json({ error: 'Invalid cursor' });

    if (!(await findRoom(pool, roomId))) return res.status(404).json({ error: 'Room not found' });
    if (!(await memberOfRoom(pool, roomId, req.user!.id))) {
      return res.status(403).json({ error: 'Join the room to read its messages' });
    }
    return res.json(await messagePage(pool, 'room_id', roomId, page));
  });

  router.get('/dms', async (req, res) => {
    res.json(await listDms(pool, req.user!.id));
  });

  router.post('/dms', async (req, res) => {
    const parsed = createDmSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid userId is required' });

    const me = req.user!;
    const otherId = parsed.data.userId;
    if (otherId === me.id) {
      return res.status(400).json({ error: 'Cannot create a DM with yourself' });
    }
    if (!(await findUser(pool, otherId))) {
      return res.status(404).json({ error: 'User not found' });
    }

    // dm_conversations enforces user_one_id < user_two_id, so normalise the
    // pair and let the unique constraint make this idempotent.
    const [first, second] = me.id < otherId ? [me.id, otherId] : [otherId, me.id];
    const result = await pool.query<{ id: number; created: boolean }>(
      `INSERT INTO dm_conversations (user_one_id, user_two_id) VALUES ($1, $2)
       ON CONFLICT ON CONSTRAINT dm_unique_pair
       DO UPDATE SET user_one_id = EXCLUDED.user_one_id
       RETURNING id, (xmax = 0) AS created`,
      [first, second],
    );
    const conversationId = Number(result.rows[0]!.id);

    if (result.rows[0]!.created) {
      // Each side sees a different "other user", so render the summary per recipient.
      for (const viewerId of [me.id, otherId]) {
        const conversation = await findDm(pool, conversationId, viewerId);
        if (conversation) hub.toUsers([viewerId], { type: 'dm:created', conversation });
      }
    }
    return res.status(201).json({ conversationId });
  });

  router.get('/dms/:id/messages', async (req, res) => {
    const conversationId = parsePositiveId(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'Invalid conversation id' });

    const page = pagination(req.query as Record<string, unknown>);
    if (page.invalidBefore) return res.status(400).json({ error: 'Invalid cursor' });

    const exists = await pool.query('SELECT 1 FROM dm_conversations WHERE id = $1', [
      conversationId,
    ]);
    if (!exists.rowCount) return res.status(404).json({ error: 'Conversation not found' });
    if (!(await dmParticipant(pool, conversationId, req.user!.id))) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    return res.json(await messagePage(pool, 'conversation_id', conversationId, page));
  });

  router.get('/users', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const result = await pool.query<{ id: number; username: string }>(
      `SELECT id, username FROM users
       WHERE id <> $1 AND ($2 = '' OR username ILIKE '%' || $2 || '%')
       ORDER BY username LIMIT 50`,
      [req.user!.id, q],
    );
    res.json(result.rows.map((row) => ({ id: Number(row.id), username: row.username })));
  });

  router.get('/presence', async (_req, res) => {
    const result = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id');
    res.json(
      result.rows.map((row) => ({
        userId: Number(row.id),
        status: hub.isOnline(Number(row.id)) ? 'online' : 'offline',
      })),
    );
  });

  return router;
}
