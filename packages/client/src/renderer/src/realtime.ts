import {
  WS_CLOSE_UNAUTHORIZED,
  type ClientFrame,
  type ServerEvent,
} from '@chateria/protocol';
import { applyServerEvent, chat, useChat } from './store.ts';

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;
const HEARTBEAT_MS = 25_000;

export interface RealtimeHandle {
  close(): void;
}

function websocketUrl(serverUrl: string, token: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Owns one socket for the signed-in session and reconnects with backoff.
 * Resubscribes to whatever room is open when a new socket comes up, because
 * subscriptions live on the server connection and do not survive a drop.
 */
export function connectRealtime(
  serverUrl: string,
  token: string,
  onUnauthorized: () => void,
): RealtimeHandle {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;
  let closed = false;

  const send = (frame: ClientFrame): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  chat.setSend(send);

  function open(): void {
    if (closed) return;
    chat.setConnection('connecting');

    socket = new WebSocket(websocketUrl(serverUrl, token));

    socket.onopen = () => {
      attempts = 0;
      // Subscriptions are per-connection server state, so a reconnect has to
      // re-announce whichever room the user is currently looking at.
      const { active } = useChat.getState();
      if (active?.type === 'room') send({ type: 'room:subscribe', roomId: active.id });
      heartbeat = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS);
    };

    socket.onmessage = (raw) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(raw.data)) as ServerEvent;
      } catch {
        return;
      }
      applyServerEvent(event);
    };

    socket.onclose = (event) => {
      clearInterval(heartbeat);
      if (closed) return;

      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        chat.setConnection('offline');
        onUnauthorized();
        return;
      }

      chat.setConnection('offline');
      attempts += 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(open, delay);
    };

    socket.onerror = () => socket?.close();
  }

  open();

  return {
    close(): void {
      closed = true;
      clearTimeout(reconnectTimer);
      clearInterval(heartbeat);
      chat.setSend(() => {});
      socket?.close();
      chat.setConnection('offline');
    },
  };
}
