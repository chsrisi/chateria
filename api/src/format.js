export function messageFromRow(row) {
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

export function parsePositiveId(value) {
  if (!/^\d+$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function pagination(query) {
  let limit = Number.parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 100);
  const before = query.before == null || query.before === ''
    ? null
    : parsePositiveId(query.before);
  return { limit, before, invalidBefore: query.before != null && query.before !== '' && before == null };
}
