import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';

function getWsUrl(token) {
  if (import.meta.env.VITE_WS_URL) {
    return `${import.meta.env.VITE_WS_URL}?token=${encodeURIComponent(token)}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

async function request(path, token, options = {}) {
  const response = await fetch(`${API}/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({ error: 'Unexpected server response' }));
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

function Auth({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');

    try {
      const payload = await request(`/auth/${mode}`, null, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onAuthenticated(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand-mark">C</div>
        <p className="eyebrow">REAL-TIME CONVERSATIONS</p>
        <h1>{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</h1>
        <p className="muted">Rooms for everyone. Messages for just the two of you.</p>

        <form onSubmit={submit}>
          <label>
            Username
            <input
              data-testid={mode === 'login' ? 'login-username' : 'register-username'}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>

          <label>
            Password
            <input
              data-testid={mode === 'login' ? 'login-password' : 'register-password'}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}

          <button
            className="primary full"
            data-testid={mode === 'login' ? 'login-submit' : 'register-submit'}
            disabled={busy}
          >
            {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>

        {mode === 'login' ? (
          <button
            data-testid="register-link"
            className="text-button"
            onClick={() => {
              setMode('register');
              setError('');
            }}
          >
            New here? Create an account
          </button>
        ) : (
          <button
            className="text-button"
            onClick={() => {
              setMode('login');
              setError('');
            }}
          >
            Already have an account? Log in
          </button>
        )}
      </section>
    </main>
  );
}

function Sidebar({
  rooms,
  dms,
  active,
  presence,
  people,
  onSelectRoom,
  onSelectDm,
  onCreateRoom,
  onNewDm,
  onLogout,
}) {
  const userNames = useMemo(
    () => new Map(people.map((user) => [user.id, user.username])),
    [people]
  );

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark small">C</div>
        <strong>Chateria</strong>
      </div>

      <nav>
        <div className="nav-heading">
          <span>Rooms</span>
          <button data-testid="create-room-btn" aria-label="Create room" onClick={onCreateRoom}>
            +
          </button>
        </div>

        <div data-testid="room-list" className="nav-list">
          {rooms.map((room) => (
            <button
              key={room.id}
              data-testid={`room-item-${room.id}`}
              className={active?.type === 'room' && active.id === room.id ? 'nav-item active' : 'nav-item'}
              onClick={() => onSelectRoom(room)}
            >
              <span className="hash">#</span>
              <span>{room.name}</span>
              <small>{room.memberCount}</small>
            </button>
          ))}
          {!rooms.length && <p className="empty-small">No rooms yet</p>}
        </div>

        <div className="nav-heading">
          <span>Direct messages</span>
          <button data-testid="new-dm-btn" aria-label="New direct message" onClick={onNewDm}>
            +
          </button>
        </div>

        <div data-testid="dm-list" className="nav-list">
          {dms.map((dm) => (
            <button
              key={dm.conversationId}
              data-testid={`dm-item-${dm.conversationId}`}
              className={active?.type === 'dm' && active.id === dm.conversationId ? 'nav-item active' : 'nav-item'}
              onClick={() => onSelectDm(dm)}
            >
              <span className="avatar tiny">{dm.otherUser.username.slice(0, 1).toUpperCase()}</span>
              <span>{dm.otherUser.username}</span>
            </button>
          ))}
          {!dms.length && <p className="empty-small">Start a private chat</p>}
        </div>
      </nav>

      <div className="presence-block">
        <div className="nav-heading static">
          <span>People</span>
        </div>
        <div data-testid="presence-list" className="presence-list">
          {presence.map((item) => (
            <div
              key={item.userId}
              data-testid={`presence-item-${item.userId}`}
              data-status={item.status}
              className="presence-item"
            >
              <i className={`status ${item.status}`} />
              <span>{userNames.get(item.userId) || `User ${item.userId}`}</span>
            </div>
          ))}
          {!presence.length && <p className="empty-small">No users yet</p>}
        </div>
      </div>

      <button data-testid="logout-btn" className="logout" onClick={onLogout}>
        Log out
      </button>
    </aside>
  );
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="Close modal">×</button>
        </div>
        {children}
      </section>
    </div>
  );
}

function CreateRoomModal({ token, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    try {
      const room = await request('/rooms', token, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      onCreated({ ...room, memberCount: 1 });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal title="Create a room" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Room name
          <input
            autoFocus
            data-testid="room-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. general"
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button data-testid="room-create-submit" className="primary full">
          Create room
        </button>
      </form>
    </Modal>
  );
}

function NewDmModal({ token, onClose, onCreated }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      request(`/users?q=${encodeURIComponent(query)}`, token)
        .then(setUsers)
        .catch((err) => setError(err.message));
    }, 150);
    return () => clearTimeout(timer);
  }, [query, token]);

  async function choose(user) {
    try {
      const result = await request('/dms', token, {
        method: 'POST',
        body: JSON.stringify({ userId: user.id }),
      });
      onCreated({
        conversationId: result.conversationId,
        otherUser: user,
        lastMessage: null,
      });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal title="New direct message" onClose={onClose}>
      <input
        autoFocus
        data-testid="user-search-input"
        placeholder="Search by username"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p className="form-error">{error}</p>}
      <div className="user-results">
        {users.map((user) => (
          <button
            key={user.id}
            data-testid={`user-result-${user.id}`}
            onClick={() => choose(user)}
          >
            <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <span>{user.username}</span>
          </button>
        ))}
        {!users.length && <p className="empty-small">No users found</p>}
      </div>
    </Modal>
  );
}

function Chat({
  active,
  messages,
  nextCursor,
  currentUser,
  typingUsers,
  onLoadOlder,
  onSend,
  onTyping,
  onLeave,
}) {
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(true);
  const [unread, setUnread] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const listRef = useRef(null);
  const pinnedRef = useRef(true);
  const scrollOffsetRef = useRef(null);
  const lastId = messages.at(-1)?.id;
  const firstId = messages[0]?.id;

  const scrollToBottom = useCallback((behavior = 'auto') => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior });
    pinnedRef.current = true;
    setPinned(true);
    setUnread(false);
  }, []);

  function handleScroll() {
    const list = listRef.current;
    if (!list) return;
    const threshold = 60;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= threshold;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
    if (atBottom) {
      setUnread(false);
    }
  }

  // Switching conversations always scrolls to bottom
  useLayoutEffect(() => {
    scrollOffsetRef.current = null;
    setUnread(false);
    pinnedRef.current = true;
    setPinned(true);
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [active?.id]);

  // A new message only auto-scrolls down if the user was already at the bottom
  useLayoutEffect(() => {
    if (!lastId) return;
    const list = listRef.current;
    if (!list) return;

    if (pinnedRef.current) {
      list.scrollTop = list.scrollHeight;
      setUnread(false);
    } else {
      setUnread(true);
    }
  }, [lastId]);

  // Prepending older messages keeps viewport locked at the same message
  useLayoutEffect(() => {
    const list = listRef.current;
    const snapshot = scrollOffsetRef.current;
    if (!list || !snapshot) return;
    scrollOffsetRef.current = null;
    const delta = list.scrollHeight - snapshot.scrollHeight;
    list.scrollTop = snapshot.scrollTop + delta;
  }, [firstId]);

  async function loadOlder() {
    const list = listRef.current;
    if (!list || loadingOlder || !nextCursor) return;
    scrollOffsetRef.current = {
      scrollHeight: list.scrollHeight,
      scrollTop: list.scrollTop,
    };
    setLoadingOlder(true);
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
      scrollOffsetRef.current = null;
    }
  }

  function submit(event) {
    event.preventDefault();
    if (!body.trim()) return;
    onSend(body);
    setBody('');
    pinnedRef.current = true;
    setPinned(true);
    setUnread(false);
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }

  if (!active) {
    return (
      <section className="welcome-pane">
        <div>
          <p className="eyebrow">YOUR CONVERSATIONS</p>
          <h1>Pick a place to talk.</h1>
          <p>Choose a room or start a direct message from the sidebar.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <div>
          <p className="eyebrow">{active.type === 'room' ? 'PUBLIC ROOM' : 'DIRECT MESSAGE'}</p>
          <h2>{active.type === 'room' ? `# ${active.name}` : active.name}</h2>
        </div>
        {active.type === 'room' && (
          <button className="secondary" onClick={onLeave}>
            Leave room
          </button>
        )}
      </header>

      <div className="message-scroller">
        <div
          data-testid="message-list"
          className="message-list"
          ref={listRef}
          onScroll={handleScroll}
        >
          {nextCursor && (
            <button className="load-older" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          )}

          {!messages.length && (
            <div className="empty-chat">
              <span>✦</span>
              <p>This conversation is ready for its first message.</p>
            </div>
          )}

          {messages.map((message) => (
            <article
              key={message.id}
              data-testid="message-item"
              data-message-id={message.id}
              data-author-id={message.authorId}
              className={message.authorId === currentUser?.id ? 'message mine' : 'message'}
            >
              <div className="avatar">
                {message.authorUsername ? message.authorUsername.slice(0, 1).toUpperCase() : '?'}
              </div>
              <div className="message-content">
                <div className="message-meta">
                  <strong>{message.authorUsername}</strong>
                  <time>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <p>{message.body}</p>
              </div>
            </article>
          ))}
        </div>

        {!pinned && (
          <button
            className="jump-latest"
            data-testid="jump-latest"
            onClick={() => scrollToBottom('smooth')}
          >
            {unread ? 'New messages' : 'Jump to latest'} ↓
          </button>
        )}
      </div>

      <div className="typing-line">
        {typingUsers.length
          ? `${typingUsers.join(', ')} ${typingUsers.length === 1 ? 'is' : 'are'} typing…`
          : '\u00A0'}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          data-testid="message-input"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            onTyping();
          }}
          placeholder={`Message ${active.type === 'room' ? `#${active.name}` : active.name}`}
          maxLength={4000}
        />
        <button data-testid="message-send" aria-label="Send message">
          ↑
        </button>
      </form>
    </section>
  );
}

export default function App() {
  const [session, setSession] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('chateria-session')) || null;
    } catch {
      return null;
    }
  });
  const [rooms, setRooms] = useState([]);
  const [dms, setDms] = useState([]);
  const [presence, setPresence] = useState([]);
  const [people, setPeople] = useState([]);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState('');
  const [typing, setTyping] = useState([]);

  const socketRef = useRef(null);
  const activeRef = useRef(null);
  activeRef.current = active;
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const typingTimers = useRef(new Map());

  const logout = useCallback(() => {
    socketRef.current?.close();
    localStorage.removeItem('chateria-session');
    setSession(null);
    setActive(null);
    setMessages([]);
  }, []);

  const loadNav = useCallback(async () => {
    if (!session) return;
    try {
      const [newRooms, newDms, newPresence, users] = await Promise.all([
        request('/rooms', session.token),
        request('/dms', session.token),
        request('/presence', session.token),
        request('/users', session.token),
      ]);
      setRooms(newRooms);
      setDms(newDms);
      setPresence(newPresence);
      setPeople([session.user, ...users]);
    } catch (error) {
      if (/credentials|token|Authentication/i.test(error.message)) {
        logout();
      } else {
        setNotice(error.message);
      }
    }
  }, [session, logout]);

  useEffect(() => {
    loadNav();
  }, [loadNav]);

  useEffect(() => {
    if (!session) return undefined;
    let stopped = false;
    let reconnectTimer;

    function connect() {
      const ws = new WebSocket(getWsUrl(session.token));
      socketRef.current = ws;

      ws.onopen = () => {
        if (activeRef.current?.type === 'room') {
          ws.send(JSON.stringify({ type: 'room:subscribe', roomId: activeRef.current.id }));
        }
      };

      ws.onmessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }

        if (frame.type === 'message:new') {
          const selected = activeRef.current;
          const belongs =
            selected &&
            ((selected.type === 'room' && frame.message.roomId === selected.id) ||
              (selected.type === 'dm' && frame.message.conversationId === selected.id));

          if (belongs) {
            setMessages((old) =>
              old.some((item) => item.id === frame.message.id) ? old : [...old, frame.message]
            );
          }
          setDms((old) =>
            old.map((dm) =>
              dm.conversationId === frame.message.conversationId
                ? { ...dm, lastMessage: frame.message }
                : dm
            )
          );
        } else if (frame.type === 'presence:update') {
          setPresence((old) => {
            const exists = old.some((item) => item.userId === frame.userId);
            if (exists) {
              return old.map((item) =>
                item.userId === frame.userId ? { ...item, status: frame.status } : item
              );
            }
            return [...old, { userId: frame.userId, status: frame.status }];
          });

          if (!peopleRef.current.some((user) => user.id === frame.userId)) {
            loadNav();
          }
        } else if (
          frame.type === 'typing' &&
          activeRef.current?.type === 'room' &&
          activeRef.current.id === frame.roomId
        ) {
          const name =
            peopleRef.current.find((user) => user.id === frame.userId)?.username || `User ${frame.userId}`;
          setTyping((old) => (old.includes(name) ? old : [...old, name]));
          clearTimeout(typingTimers.current.get(frame.userId));
          typingTimers.current.set(
            frame.userId,
            setTimeout(() => {
              setTyping((old) => old.filter((item) => item !== name));
            }, 1800)
          );
        } else if (frame.type === 'error') {
          setNotice(frame.error);
        }
      };

      ws.onclose = (event) => {
        if (!stopped) {
          if (event.code === 4401) {
            logout();
          } else {
            reconnectTimer = setTimeout(connect, 1200);
          }
        }
      };
    }

    connect();

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, [session, logout, loadNav]);

  async function selectRoom(room) {
    try {
      const previous = activeRef.current;
      if (previous?.type === 'room') {
        socketRef.current?.send(JSON.stringify({ type: 'room:unsubscribe', roomId: previous.id }));
      }
      await request(`/rooms/${room.id}/join`, session.token, { method: 'POST' });
      const page = await request(`/rooms/${room.id}/messages`, session.token);
      const selected = { type: 'room', id: room.id, name: room.name };
      activeRef.current = selected;
      setActive(selected);
      setMessages(page.messages);
      setNextCursor(page.nextCursor);
      setTyping([]);
      socketRef.current?.send(JSON.stringify({ type: 'room:subscribe', roomId: room.id }));
      loadNav();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function selectDm(dm) {
    try {
      const previous = activeRef.current;
      if (previous?.type === 'room') {
        socketRef.current?.send(JSON.stringify({ type: 'room:unsubscribe', roomId: previous.id }));
      }
      const page = await request(`/dms/${dm.conversationId}/messages`, session.token);
      const selected = { type: 'dm', id: dm.conversationId, name: dm.otherUser.username };
      activeRef.current = selected;
      setActive(selected);
      setMessages(page.messages);
      setNextCursor(page.nextCursor);
      setTyping([]);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function loadOlder() {
    if (!active || !nextCursor) return;
    const path =
      active.type === 'room'
        ? `/rooms/${active.id}/messages`
        : `/dms/${active.id}/messages`;
    try {
      const page = await request(`${path}?before=${nextCursor}`, session.token);
      setMessages((old) => [...page.messages, ...old]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setNotice(error.message);
    }
  }

  function sendMessage(body) {
    if (!active || socketRef.current?.readyState !== WebSocket.OPEN) {
      return setNotice('Reconnecting…');
    }
    const destination =
      active.type === 'room' ? { roomId: active.id } : { conversationId: active.id };
    socketRef.current.send(JSON.stringify({ type: 'message:send', ...destination, body }));
  }

  function sendTyping() {
    if (active?.type === 'room' && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'typing:start', roomId: active.id }));
    }
  }

  async function leaveRoom() {
    if (active?.type !== 'room') return;
    try {
      await request(`/rooms/${active.id}/leave`, session.token, { method: 'POST' });
      socketRef.current?.send(JSON.stringify({ type: 'room:unsubscribe', roomId: active.id }));
      activeRef.current = null;
      setActive(null);
      setMessages([]);
      loadNav();
    } catch (error) {
      setNotice(error.message);
    }
  }

  function authenticated(payload) {
    localStorage.setItem('chateria-session', JSON.stringify(payload));
    setSession(payload);
  }

  if (!session) {
    return <Auth onAuthenticated={authenticated} />;
  }

  return (
    <main className="app-shell">
      <Sidebar
        rooms={rooms}
        dms={dms}
        active={active}
        presence={presence}
        people={people}
        onSelectRoom={selectRoom}
        onSelectDm={selectDm}
        onCreateRoom={() => setModal('room')}
        onNewDm={() => setModal('dm')}
        onLogout={logout}
      />
      <Chat
        active={active}
        messages={messages}
        nextCursor={nextCursor}
        currentUser={session.user}
        typingUsers={typing}
        onLoadOlder={loadOlder}
        onSend={sendMessage}
        onTyping={sendTyping}
        onLeave={leaveRoom}
      />
      {modal === 'room' && (
        <CreateRoomModal
          token={session.token}
          onClose={() => setModal(null)}
          onCreated={(room) => {
            setRooms((old) => [...old, room]);
            setModal(null);
            selectRoom(room);
          }}
        />
      )}
      {modal === 'dm' && (
        <NewDmModal
          token={session.token}
          onClose={() => setModal(null)}
          onCreated={(dm) => {
            setDms((old) =>
              old.some((item) => item.conversationId === dm.conversationId)
                ? old
                : [dm, ...old]
            );
            setModal(null);
            selectDm(dm);
          }}
        />
      )}
      {notice && (
        <button className="toast" onClick={() => setNotice('')}>
          {notice}
          <span>×</span>
        </button>
      )}
    </main>
  );
}
