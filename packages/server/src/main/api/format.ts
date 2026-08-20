import type { Message } from '@chateria/protocol';

export interface MessageRow {
  id: number | string;
  body: string;
  author_id: number | string;
  author_username: string;
  created_at: Date | string;
  room_id: number | string | null;
  conversation_id: number | string | null;
}

/** The single place raw pg rows become the wire shape. */
export function messageFromRow(row: MessageRow): Message {
  return {
    id: Number(row.id),
    body: row.body,
    authorId: Number(row.author_id),
    authorUsername: row.author_username,
    createdAt: new Date(row.created_at).toISOString(),
    roomId: row.room_id == null ? null : Number(row.room_id),
    conversationId: row.conversation_id == null ? null : Number(row.conversation_id),
  };
}

export function parsePositiveId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export interface Pagination {
  limit: number;
  before: number | null;
  invalidBefore: boolean;
}

export function pagination(query: Record<string, unknown>): Pagination {
  let limit = Number.parseInt(String(query.limit ?? ''), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_PAGE_SIZE;
  limit = Math.min(limit, MAX_PAGE_SIZE);

  const raw = query.before;
  const supplied = raw != null && raw !== '';
  const before = supplied ? parsePositiveId(raw) : null;
  return { limit, before, invalidBefore: supplied && before == null };
}
