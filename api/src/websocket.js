import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from './auth.js';
import { pool } from './db.js';
import { messageFromRow, parsePositiveId } from './format.js';
import { dmParticipant, memberOfRoom } from './routes.js';

const maxMessageLength = Number.parseInt(process.env.MAX_MESSAGE_LENGTH || '4000', 10);

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function createRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  const connectionCounts = new Map();
  let messageQueue = Promise.resolve();

  const broadcast = (payload, predicate = () => true) => {
    for (const client of clients) if (predicate(client)) send(client, payload);
  };

  const presence = {
    isOnline(userId) {
      return (connectionCounts.get(userId) || 0) > 0;
    },
  };

  server.on('upgrade', (request, socket, head) => {
    let token;
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/ws') return socket.destroy();
      token = url.searchParams.get('token');
    } catch {
      return socket.destroy();
    }

    let user;
    try {
      if (!token) throw new Error('Missing token');
      user = verifyToken(token);
    } catch {
      return wss.handleUpgrade(request, socket, head, (ws) => ws.close(4401, 'Unauthorized'));
    }

    return wss.handleUpgrade(request, socket, head, (ws) => {
      ws.user = user;
      ws.subscriptions = new Set();
      wss.emit('connection', ws);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.operationQueue = Promise.resolve();
    const oldCount = connectionCounts.get(ws.user.id) || 0;
    connectionCounts.set(ws.user.id, oldCount + 1);
    if (oldCount === 0) broadcast({ type: 'presence:update', userId: ws.user.id, status: 'online' });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', error: 'Malformed JSON frame' });
        return;
      }
      if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
        send(ws, { type: 'error', error: 'Malformed frame' });
        return;
      }

      if (frame.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      if (frame.type === 'message:send') {
        ws.operationQueue = ws.operationQueue.then(async () => {
          messageQueue = messageQueue.catch(() => {}).then(() => persistAndBroadcast(ws, frame));
          await messageQueue;
        }).catch(() => send(ws, { type: 'error', error: 'Unable to send message' }));
        return;
      }

      ws.operationQueue = ws.operationQueue
        .then(() => handleFrame(ws, frame))
        .catch(() => send(ws, { type: 'error', error: 'Unable to process frame' }));
    });

    ws.on('close', () => {
      clients.delete(ws);
      const count = connectionCounts.get(ws.user.id) || 1;
      if (count <= 1) {
        connectionCounts.delete(ws.user.id);
        broadcast({ type: 'presence:update', userId: ws.user.id, status: 'offline' });
      } else {
        connectionCounts.set(ws.user.id, count - 1);
      }
    });
  });

  async function handleFrame(ws, frame) {
    if (frame.type === 'room:subscribe' || frame.type === 'room:unsubscribe') {
      const roomId = parsePositiveId(frame.roomId);
      if (!roomId) return send(ws, { type: 'error', error: 'Invalid roomId' });
      if (frame.type === 'room:subscribe') {
        if (!(await memberOfRoom(roomId, ws.user.id))) return send(ws, { type: 'error', error: 'Not a room member' });
        ws.subscriptions.add(roomId);
      } else {
        ws.subscriptions.delete(roomId);
      }
      return;
    }

    if (frame.type === 'typing:start') {
      const roomId = parsePositiveId(frame.roomId);
      if (!roomId || !(await memberOfRoom(roomId, ws.user.id))) return send(ws, { type: 'error', error: 'Not a room member' });
      broadcast(
        { type: 'typing', userId: ws.user.id, roomId },
        (client) => client.subscriptions.has(roomId) && client !== ws,
      );
      return;
    }

    send(ws, { type: 'error', error: 'Unknown frame type' });
  }

  async function persistAndBroadcast(ws, frame) {
    const roomId = frame.roomId == null ? null : parsePositiveId(frame.roomId);
    const conversationId = frame.conversationId == null ? null : parsePositiveId(frame.conversationId);
    const body = typeof frame.body === 'string' ? frame.body.trim() : '';
    if ((!roomId && !conversationId) || (roomId && conversationId)) return send(ws, { type: 'error', error: 'Exactly one destination is required' });
    if (!body || body.length > maxMessageLength) return send(ws, { type: 'error', error: 'Invalid message body' });

    if (roomId && !(await memberOfRoom(roomId, ws.user.id))) return send(ws, { type: 'error', error: 'Not a room member' });
    if (conversationId && !(await dmParticipant(conversationId, ws.user.id))) return send(ws, { type: 'error', error: 'Not a DM participant' });

    const result = await pool.query(`
      WITH inserted AS (
        INSERT INTO messages (body, author_id, room_id, conversation_id)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      )
      SELECT inserted.*, u.username AS author_username
      FROM inserted JOIN users u ON u.id = inserted.author_id
    `, [body, ws.user.id, roomId, conversationId]);
    const message = messageFromRow(result.rows[0]);

    if (roomId) {
      const memberships = await pool.query('SELECT user_id FROM room_members WHERE room_id = $1', [roomId]);
      const members = new Set(memberships.rows.map((row) => Number(row.user_id)));
      broadcast(
        { type: 'message:new', message },
        (client) => members.has(client.user.id) && client.subscriptions.has(roomId),
      );
    } else {
      const participants = await pool.query(
        'SELECT user_one_id, user_two_id FROM dm_conversations WHERE id = $1', [conversationId],
      );
      const allowed = new Set([Number(participants.rows[0].user_one_id), Number(participants.rows[0].user_two_id)]);
      broadcast({ type: 'message:new', message }, (client) => allowed.has(client.user.id));
    }
  }

  return { wss, presence };
}
