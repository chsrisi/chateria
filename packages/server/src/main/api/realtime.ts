import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  type PublicUser,
  type ServerEvent,
} from '@chateria/protocol';
import { verifyToken } from './auth.ts';
import type { Pool } from './db.ts';
import { clientFrameSchema, type ParsedClientFrame } from './frames.ts';
import type { SigningKeys } from './keys.ts';
import {
  dmParticipant,
  dmParticipantIds,
  insertMessage,
  memberOfRoom,
  roomMemberIds,
} from './queries.ts';

interface Client extends WebSocket {
  user: PublicUser;
  subscriptions: Set<number>;
  /** Serialises this connection's frames so ordering per client is stable. */
  queue: Promise<void>;
}

export interface HubOptions {
  pool: Pool;
  keys: SigningKeys;
  maxMessageLength: number;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ConnectedUser extends PublicUser {
  connections: number;
}

/**
 * The realtime hub owns every open socket. REST handlers hold a reference to
 * it and call `toAll` / `toUsers` so a state change made over HTTP (a room
 * created, a member joined) reaches connected clients immediately instead of
 * waiting for them to refetch.
 */
export interface Hub {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  toAll(event: ServerEvent): void;
  toUsers(userIds: Iterable<number>, event: ServerEvent): void;
  isOnline(userId: number): boolean;
  onlineUserIds(): number[];
  connectedUsers(): ConnectedUser[];
  socketCount(): number;
  close(): Promise<void>;
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

export function createHub(options: HubOptions): Hub {
  const { pool, keys, maxMessageLength } = options;
  const log = options.onLog ?? (() => {});

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();
  /** userId -> open connection count. Process-local by design. */
  const connectionCounts = new Map<number, number>();
  const usernames = new Map<number, string>();

  /**
   * A single process-wide chain for message inserts. Without it, two clients
   * sending at once could have their rows committed in one order and broadcast
   * in another, so a room's history would not match what people saw live.
   */
  let writeChain: Promise<void> = Promise.resolve();

  function broadcast(event: ServerEvent, predicate: (client: Client) => boolean): void {
    for (const client of clients) {
      if (predicate(client)) send(client, event);
    }
  }

  const hub: Hub = {
    handleUpgrade(request, socket, head) {
      let token: string | null = null;
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/ws') {
          socket.destroy();
          return;
        }
        token = url.searchParams.get('token');
      } catch {
        socket.destroy();
        return;
      }

      // Authenticate before completing the handshake, but still complete it on
      // failure so the client receives a close code it can act on (4401 = log out)
      // rather than an opaque socket reset it would try to reconnect through.
      void (async () => {
        let user: PublicUser;
        try {
          if (!token) throw new Error('Missing token');
          user = await verifyToken(token, keys);
        } catch {
          wss.handleUpgrade(request, socket, head, (ws) =>
            ws.close(WS_CLOSE_UNAUTHORIZED, 'Unauthorized'),
          );
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          const client = ws as Client;
          client.user = user;
          client.subscriptions = new Set();
          client.queue = Promise.resolve();
          wss.emit('connection', client, request);
        });
      })();
    },

    toAll(event) {
      broadcast(event, () => true);
    },

    toUsers(userIds, event) {
      const allowed = new Set(userIds);
      broadcast(event, (client) => allowed.has(client.user.id));
    },

    isOnline(userId) {
      return (connectionCounts.get(userId) ?? 0) > 0;
    },

    onlineUserIds() {
      return [...connectionCounts.keys()];
    },

    connectedUsers() {
      return [...connectionCounts.entries()].map(([id, connections]) => ({
        id,
        username: usernames.get(id) ?? `user-${id}`,
        connections,
      }));
    },

    socketCount() {
      return clients.size;
    },

    close() {
      for (const client of clients) client.terminate();
      clients.clear();
      connectionCounts.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket) => {
    const client = socket as Client;
    clients.add(client);
    usernames.set(client.user.id, client.user.username);

    const previous = connectionCounts.get(client.user.id) ?? 0;
    connectionCounts.set(client.user.id, previous + 1);

    send(client, {
      type: 'welcome',
      user: client.user,
      protocolVersion: PROTOCOL_VERSION,
      maxMessageLength,
    });

    // Only the first connection flips presence; extra windows must not re-announce.
    if (previous === 0) {
      hub.toAll({
        type: 'presence:update',
        userId: client.user.id,
        username: client.user.username,
        status: 'online',
      });
      log('info', `${client.user.username} came online`);
    }

    client.on('message', (raw) => {
      let frame: ParsedClientFrame;
      try {
        const parsed = clientFrameSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) {
          send(client, { type: 'error', error: 'Unsupported or malformed frame' });
          return;
        }
        frame = parsed.data;
      } catch {
        send(client, { type: 'error', error: 'Malformed JSON frame' });
        return;
      }

      if (frame.type === 'ping') {
        send(client, { type: 'pong' });
        return;
      }

      if (frame.type === 'message:send') {
        // Per-client ordering, then global write ordering.
        client.queue = client.queue
          .then(() => {
            writeChain = writeChain.catch(() => {}).then(() => persistAndFanOut(client, frame));
            return writeChain;
          })
          .catch((error: unknown) => {
            log('error', `message:send failed: ${String(error)}`);
            send(client, {
              type: 'error',
              error: 'Unable to send message',
              inReplyTo: 'message:send',
            });
          });
        return;
      }

      client.queue = client.queue.then(() => handleFrame(client, frame)).catch(() => {
        send(client, { type: 'error', error: 'Unable to process frame', inReplyTo: frame.type });
      });
    });

    client.on('close', () => {
      clients.delete(client);
      const count = connectionCounts.get(client.user.id) ?? 1;
      if (count <= 1) {
        connectionCounts.delete(client.user.id);
        hub.toAll({
          type: 'presence:update',
          userId: client.user.id,
          username: client.user.username,
          status: 'offline',
        });
        log('info', `${client.user.username} went offline`);
      } else {
        connectionCounts.set(client.user.id, count - 1);
      }
    });

    client.on('error', () => client.terminate());
  });

  async function handleFrame(client: Client, frame: ParsedClientFrame): Promise<void> {
    switch (frame.type) {
      case 'room:subscribe': {
        if (!(await memberOfRoom(pool, frame.roomId, client.user.id))) {
          send(client, {
            type: 'error',
            error: 'Not a room member',
            inReplyTo: 'room:subscribe',
          });
          return;
        }
        client.subscriptions.add(frame.roomId);
        return;
      }
      case 'room:unsubscribe': {
        client.subscriptions.delete(frame.roomId);
        return;
      }
      case 'typing:start': {
        if (!(await memberOfRoom(pool, frame.roomId, client.user.id))) {
          send(client, { type: 'error', error: 'Not a room member', inReplyTo: 'typing:start' });
          return;
        }
        broadcast(
          {
            type: 'typing',
            roomId: frame.roomId,
            userId: client.user.id,
            username: client.user.username,
          },
          (peer) => peer !== client && peer.subscriptions.has(frame.roomId),
        );
        return;
      }
      default:
        return;
    }
  }

  async function persistAndFanOut(
    client: Client,
    frame: Extract<ParsedClientFrame, { type: 'message:send' }>,
  ): Promise<void> {
    const roomId = frame.roomId ?? null;
    const conversationId = frame.conversationId ?? null;
    const body = frame.body.trim();

    if ((roomId === null) === (conversationId === null)) {
      send(client, {
        type: 'error',
        error: 'Exactly one destination is required',
        inReplyTo: 'message:send',
      });
      return;
    }
    if (!body || body.length > maxMessageLength) {
      send(client, { type: 'error', error: 'Invalid message body', inReplyTo: 'message:send' });
      return;
    }

    if (roomId !== null && !(await memberOfRoom(pool, roomId, client.user.id))) {
      send(client, { type: 'error', error: 'Not a room member', inReplyTo: 'message:send' });
      return;
    }
    if (conversationId !== null && !(await dmParticipant(pool, conversationId, client.user.id))) {
      send(client, { type: 'error', error: 'Not a DM participant', inReplyTo: 'message:send' });
      return;
    }

    const message = await insertMessage(pool, {
      body,
      authorId: client.user.id,
      roomId,
      conversationId,
    });

    if (roomId !== null) {
      // Room delivery needs membership AND an active subscription: a member who
      // is looking at another room should not receive its live traffic.
      const members = new Set(await roomMemberIds(pool, roomId));
      broadcast(
        { type: 'message:new', message },
        (peer) => peer !== client && members.has(peer.user.id) && peer.subscriptions.has(roomId),
      );
    } else {
      // DMs have no subscribe step -- both participants always receive them.
      const participants = new Set(await dmParticipantIds(pool, conversationId!));
      broadcast(
        { type: 'message:new', message },
        (peer) => peer !== client && participants.has(peer.user.id),
      );
    }

    // The sender's own copy carries the nonce back so an optimistic bubble can
    // be reconciled instead of duplicated.
    send(client, {
      type: 'message:new',
      message,
      ...(frame.clientNonce ? { clientNonce: frame.clientNonce } : {}),
    });
  }

  return hub;
}
