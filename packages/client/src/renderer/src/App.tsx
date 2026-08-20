import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthResult, DmSummary, PresenceStatus, RoomSummary } from '@chateria/protocol';
import { ApiError, createApi } from './api.ts';
import { connectRealtime, type RealtimeHandle } from './realtime.ts';
import { chat, useChat, type Target } from './store.ts';
import { Auth } from './components/Auth.tsx';
import { Chat } from './components/Chat.tsx';
import { CreateRoomModal } from './components/CreateRoomModal.tsx';
import { NewDmModal } from './components/NewDmModal.tsx';
import { Sidebar } from './components/Sidebar.tsx';

const TYPING_THROTTLE_MS = 1_200;

export default function App() {
  const session = useChat((state) => state.session);
  const serverUrl = useChat((state) => state.serverUrl);
  const active = useChat((state) => state.active);
  const notice = useChat((state) => state.notice);
  const unread = useChat((state) => state.unread);
  const send = useChat((state) => state.send);

  const [ready, setReady] = useState(false);
  const [modal, setModal] = useState<'room' | 'dm' | null>(null);
  const [maxMessageLength, setMaxMessageLength] = useState(4_000);

  const realtimeRef = useRef<RealtimeHandle | null>(null);
  const lastTypingRef = useRef(0);
  const activeRef = useRef<Target | null>(null);
  activeRef.current = active;

  const api = useMemo(
    () => createApi(serverUrl, session?.token),
    [serverUrl, session?.token],
  );

  /* -------------------- session bootstrap -------------------- */

  useEffect(() => {
    void (async () => {
      const [storedUrl, stored] = await Promise.all([
        window.chateria.getServerUrl(),
        window.chateria.getSession(),
      ]);
      chat.setServerUrl(stored?.serverUrl ?? storedUrl);
      if (stored) chat.setSession({ token: stored.token, user: stored.user });
      setReady(true);
    })();
  }, []);

  const signOut = useCallback(() => {
    realtimeRef.current?.close();
    realtimeRef.current = null;
    void window.chateria.clearSession();
    void window.chateria.setBadge(0);
    const url = useChat.getState().serverUrl;
    chat.reset();
    chat.setServerUrl(url);
  }, []);

  /* -------------------- directory + socket -------------------- */

  const loadDirectory = useCallback(async () => {
    if (!session) return;
    try {
      const [rooms, dms, people, presenceList, info] = await Promise.all([
        api.rooms(),
        api.dms(),
        api.users(),
        api.presence(),
        api.info(),
      ]);
      const presence: Record<number, PresenceStatus> = {};
      for (const entry of presenceList) presence[entry.userId] = entry.status;
      chat.setDirectory({ rooms, dms, people: [session.user, ...people], presence });
      setMaxMessageLength(info.maxMessageLength);
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) signOut();
      else chat.setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [api, session, signOut]);

  useEffect(() => {
    if (!session) return;
    void loadDirectory();
  }, [session, loadDirectory]);

  useEffect(() => {
    if (!session || !serverUrl) return;
    const handle = connectRealtime(serverUrl, session.token, signOut);
    realtimeRef.current = handle;
    return () => {
      handle.close();
      realtimeRef.current = null;
    };
  }, [session, serverUrl, signOut]);

  // Mirror total unread onto the dock/taskbar badge.
  useEffect(() => {
    const total = Object.values(unread).reduce((sum, count) => sum + count, 0);
    void window.chateria.setBadge(total);
  }, [unread]);

  /* -------------------- navigation -------------------- */

  const openRoom = useCallback(
    async (room: RoomSummary) => {
      try {
        const previous = activeRef.current;
        if (previous?.type === 'room' && previous.id !== room.id) {
          send({ type: 'room:unsubscribe', roomId: previous.id });
        }
        // Selecting a room joins it; the server broadcasts the membership change.
        if (!room.joined) await api.joinRoom(room.id);
        const page = await api.roomMessages(room.id);
        chat.openTarget({ type: 'room', id: room.id, name: room.name }, page);
        send({ type: 'room:subscribe', roomId: room.id });
      } catch (error) {
        if (error instanceof ApiError && error.isAuthFailure) signOut();
        else chat.setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [api, send, signOut],
  );

  const openDm = useCallback(
    async (dm: DmSummary) => {
      try {
        const previous = activeRef.current;
        if (previous?.type === 'room') {
          send({ type: 'room:unsubscribe', roomId: previous.id });
        }
        const page = await api.dmMessages(dm.conversationId);
        chat.openTarget(
          { type: 'dm', id: dm.conversationId, name: dm.otherUser.username },
          page,
        );
      } catch (error) {
        if (error instanceof ApiError && error.isAuthFailure) signOut();
        else chat.setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [api, send, signOut],
  );

  const loadOlder = useCallback(async () => {
    const { active: target, nextCursor } = useChat.getState();
    if (!target || nextCursor === null) return;
    try {
      const page =
        target.type === 'room'
          ? await api.roomMessages(target.id, nextCursor)
          : await api.dmMessages(target.id, nextCursor);
      chat.prependPage(page);
    } catch (error) {
      chat.setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [api]);

  const leaveRoom = useCallback(async () => {
    const target = activeRef.current;
    if (target?.type !== 'room') return;
    try {
      await api.leaveRoom(target.id);
      send({ type: 'room:unsubscribe', roomId: target.id });
      chat.closeTarget();
    } catch (error) {
      chat.setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [api, send]);

  /* -------------------- composing -------------------- */

  const sendMessage = useCallback(
    (body: string) => {
      const target = activeRef.current;
      if (!target) return;
      if (useChat.getState().connection !== 'online') {
        chat.setNotice('Reconnecting… your message was not sent.');
        return;
      }
      send({
        type: 'message:send',
        body,
        ...(target.type === 'room'
          ? { roomId: target.id }
          : { conversationId: target.id }),
      });
    },
    [send],
  );

  const sendTyping = useCallback(() => {
    const target = activeRef.current;
    if (target?.type !== 'room') return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
    lastTypingRef.current = now;
    send({ type: 'typing:start', roomId: target.id });
  }, [send]);

  /* -------------------- render -------------------- */

  async function authenticated(result: AuthResult, url: string): Promise<void> {
    await window.chateria.saveSession({ token: result.token, user: result.user, serverUrl: url });
    chat.setServerUrl(url);
    chat.setSession({ token: result.token, user: result.user });
  }

  if (!ready) return <main className="loading">Loading…</main>;

  if (!session) {
    return (
      <Auth
        serverUrl={serverUrl}
        onServerUrlChange={async (url) => {
          const saved = await window.chateria.setServerUrl(url);
          chat.setServerUrl(saved);
        }}
        onAuthenticated={(result, url) => void authenticated(result, url)}
      />
    );
  }

  return (
    <main className="app-shell">
      <Sidebar
        onSelectRoom={(room) => void openRoom(room)}
        onSelectDm={(dm) => void openDm(dm)}
        onCreateRoom={() => setModal('room')}
        onNewDm={() => setModal('dm')}
        onLogout={signOut}
      />

      <Chat
        maxMessageLength={maxMessageLength}
        onSend={sendMessage}
        onTyping={sendTyping}
        onLoadOlder={loadOlder}
        onLeave={() => void leaveRoom()}
      />

      {modal === 'room' && (
        <CreateRoomModal
          api={api}
          onClose={() => setModal(null)}
          onCreated={(room) => {
            setModal(null);
            void openRoom(room);
          }}
        />
      )}

      {modal === 'dm' && (
        <NewDmModal
          api={api}
          onClose={() => setModal(null)}
          onCreated={(conversationId, user) => {
            setModal(null);
            void openDm({ conversationId, otherUser: user, lastMessage: null });
          }}
        />
      )}

      {notice && (
        <button className="toast" onClick={() => chat.setNotice('')}>
          {notice}
          <span>×</span>
        </button>
      )}
    </main>
  );
}
