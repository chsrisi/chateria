import type { DmSummary, Message, PublicUser, RoomSummary } from '@chateria/protocol';
import type { Pool } from './db.ts';
import { messageFromRow, type MessageRow } from './format.ts';

/**
 * Authorization and lookup helpers used by BOTH the REST routes and the
 * WebSocket hub. Keeping them here is what lets those two modules stay
 * independent of each other.
 */

export async function memberOfRoom(pool: Pool, roomId: number, userId: number): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  return result.rowCount! > 0;
}

export async function dmParticipant(
  pool: Pool,
  conversationId: number,
  userId: number,
): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM dm_conversations WHERE id = $1 AND (user_one_id = $2 OR user_two_id = $2)',
    [conversationId, userId],
  );
  return result.rowCount! > 0;
}

export async function roomMemberIds(pool: Pool, roomId: number): Promise<number[]> {
  const result = await pool.query<{ user_id: number }>(
    'SELECT user_id FROM room_members WHERE room_id = $1',
    [roomId],
  );
  return result.rows.map((row) => Number(row.user_id));
}

export async function dmParticipantIds(pool: Pool, conversationId: number): Promise<number[]> {
  const result = await pool.query<{ user_one_id: number; user_two_id: number }>(
    'SELECT user_one_id, user_two_id FROM dm_conversations WHERE id = $1',
    [conversationId],
  );
  const row = result.rows[0];
  return row ? [Number(row.user_one_id), Number(row.user_two_id)] : [];
}

export async function roomMemberCount(pool: Pool, roomId: number): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = $1',
    [roomId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Room list with the requesting user's membership flag folded in. */
export async function listRooms(pool: Pool, viewerId: number): Promise<RoomSummary[]> {
  const result = await pool.query<{
    id: number;
    name: string;
    member_count: number;
    joined: boolean;
  }>(
    `SELECT r.id,
            r.name,
            COUNT(rm.user_id)::int AS member_count,
            BOOL_OR(rm.user_id = $1) AS joined
     FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id
     GROUP BY r.id
     ORDER BY r.id`,
    [viewerId],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    memberCount: Number(row.member_count),
    joined: row.joined === true,
  }));
}

export async function findRoom(pool: Pool, roomId: number): Promise<RoomSummary | null> {
  const result = await pool.query<{ id: number; name: string; member_count: number }>(
    `SELECT r.id, r.name, COUNT(rm.user_id)::int AS member_count
     FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id
     WHERE r.id = $1 GROUP BY r.id`,
    [roomId],
  );
  const row = result.rows[0];
  return row
    ? { id: Number(row.id), name: row.name, memberCount: Number(row.member_count) }
    : null;
}

interface DmRow extends MessageRow {
  conversation_pk: number;
  other_id: number;
  other_username: string;
  message_id: number | null;
}

const DM_SELECT = `
  SELECT d.id AS conversation_pk,
    CASE WHEN d.user_one_id = $1 THEN u2.id ELSE u1.id END AS other_id,
    CASE WHEN d.user_one_id = $1 THEN u2.username ELSE u1.username END AS other_username,
    lm.id AS message_id, lm.body, lm.author_id, lm.created_at,
    lm.room_id, lm.conversation_id, au.username AS author_username
  FROM dm_conversations d
  JOIN users u1 ON u1.id = d.user_one_id
  JOIN users u2 ON u2.id = d.user_two_id
  LEFT JOIN LATERAL (
    SELECT * FROM messages m WHERE m.conversation_id = d.id ORDER BY m.id DESC LIMIT 1
  ) lm ON TRUE
  LEFT JOIN users au ON au.id = lm.author_id
`;

function dmFromRow(row: DmRow): DmSummary {
  return {
    conversationId: Number(row.conversation_pk),
    otherUser: { id: Number(row.other_id), username: row.other_username },
    lastMessage:
      row.message_id == null ? null : messageFromRow({ ...row, id: row.message_id }),
  };
}

export async function listDms(pool: Pool, viewerId: number): Promise<DmSummary[]> {
  const result = await pool.query<DmRow>(
    `${DM_SELECT}
     WHERE d.user_one_id = $1 OR d.user_two_id = $1
     ORDER BY lm.id DESC NULLS LAST, d.id DESC`,
    [viewerId],
  );
  return result.rows.map(dmFromRow);
}

/**
 * One conversation as `viewerId` sees it -- the "other user" differs per side,
 * so a dm:created broadcast has to be rendered separately for each participant.
 */
export async function findDm(
  pool: Pool,
  conversationId: number,
  viewerId: number,
): Promise<DmSummary | null> {
  const result = await pool.query<DmRow>(`${DM_SELECT} WHERE d.id = $2`, [
    viewerId,
    conversationId,
  ]);
  const row = result.rows[0];
  return row ? dmFromRow(row) : null;
}

export async function findUser(pool: Pool, userId: number): Promise<PublicUser | null> {
  const result = await pool.query<{ id: number; username: string }>(
    'SELECT id, username FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0];
  return row ? { id: Number(row.id), username: row.username } : null;
}

export interface InsertMessageInput {
  body: string;
  authorId: number;
  roomId: number | null;
  conversationId: number | null;
}

export async function insertMessage(pool: Pool, input: InsertMessageInput): Promise<Message> {
  const result = await pool.query<MessageRow>(
    `WITH inserted AS (
       INSERT INTO messages (body, author_id, room_id, conversation_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *
     )
     SELECT inserted.*, u.username AS author_username
     FROM inserted JOIN users u ON u.id = inserted.author_id`,
    [input.body, input.authorId, input.roomId, input.conversationId],
  );
  return messageFromRow(result.rows[0]!);
}

/** Keyset page walking backwards from `before`, returned oldest-to-newest. */
export async function messagePage(
  pool: Pool,
  column: 'room_id' | 'conversation_id',
  destinationId: number,
  { limit, before }: { limit: number; before: number | null },
): Promise<{ messages: Message[]; nextCursor: number | null }> {
  const result = await pool.query<MessageRow>(
    `SELECT m.*, u.username AS author_username
     FROM messages m JOIN users u ON u.id = m.author_id
     WHERE m.${column} = $1 AND ($2::bigint IS NULL OR m.id < $2)
     ORDER BY m.id DESC
     LIMIT $3`,
    [destinationId, before, limit + 1],
  );

  const hasMore = result.rows.length > limit;
  const messages = result.rows.slice(0, limit).reverse().map(messageFromRow);
  return {
    messages,
    nextCursor: hasMore && messages.length ? messages[0]!.id : null,
  };
}
