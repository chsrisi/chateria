import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { chat, useChat } from '../store.ts';

export function Chat({
  maxMessageLength,
  onSend,
  onTyping,
  onLoadOlder,
  onLeave,
}: {
  maxMessageLength: number;
  onSend: (body: string) => void;
  onTyping: () => void;
  onLoadOlder: () => Promise<void>;
  onLeave: () => void;
}) {
  const active = useChat((state) => state.active);
  const messages = useChat((state) => state.messages);
  const nextCursor = useChat((state) => state.nextCursor);
  const typing = useChat((state) => state.typing);
  const me = useChat((state) => state.session?.user.id);

  const [body, setBody] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const firstId = messages[0]?.id;
  const lastId = messages[messages.length - 1]?.id;

  // Opening a conversation always lands at the newest message.
  useLayoutEffect(() => {
    anchorRef.current = null;
    pinnedRef.current = true;
    setPinned(true);
    setUnseen(false);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [active?.type, active?.id]);

  // A new message only pulls the view down if the reader was already at the end.
  useLayoutEffect(() => {
    if (lastId === undefined) return;
    const list = listRef.current;
    if (!list) return;
    if (pinnedRef.current) {
      list.scrollTop = list.scrollHeight;
      setUnseen(false);
    } else {
      setUnseen(true);
    }
  }, [lastId]);

  // Prepending an older page keeps the reader on the same message.
  useLayoutEffect(() => {
    const list = listRef.current;
    const anchor = anchorRef.current;
    if (!list || !anchor) return;
    anchorRef.current = null;
    list.scrollTop = anchor.scrollTop + (list.scrollHeight - anchor.scrollHeight);
  }, [firstId]);

  const typingNames = Object.values(typing).map((entry) => entry.username);

  // Typing indicators expire on a timer rather than an explicit stop frame,
  // so sweep them while any are showing.
  useEffect(() => {
    if (typingNames.length === 0) return;
    const timer = setInterval(() => chat.expireTyping(), 400);
    return () => clearInterval(timer);
  }, [typingNames.length]);

  if (!active) {
    return (
      <section className="welcome-pane">
        <div>
          <p className="eyebrow">Your conversations</p>
          <h1>Pick a place to talk.</h1>
          <p className="muted">Choose a room or start a direct message from the sidebar.</p>
        </div>
      </section>
    );
  }

  function handleScroll(event: React.UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
    if (atBottom) setUnseen(false);
  }

  async function loadOlder(): Promise<void> {
    const list = listRef.current;
    if (!list || loadingOlder || !nextCursor) return;
    anchorRef.current = { scrollHeight: list.scrollHeight, scrollTop: list.scrollTop };
    setLoadingOlder(true);
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!body.trim()) return;
    onSend(body);
    setBody('');
    pinnedRef.current = true;
    setPinned(true);
    setUnseen(false);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <div>
          <p className="eyebrow">{active.type === 'room' ? 'Public room' : 'Direct message'}</p>
          <h2>{active.type === 'room' ? `# ${active.name}` : active.name}</h2>
        </div>
        {active.type === 'room' && (
          <button className="ghost" onClick={onLeave}>
            Leave room
          </button>
        )}
      </header>

      <div className="message-scroller">
        <div className="message-list" ref={listRef} onScroll={handleScroll}>
          {nextCursor !== null && (
            <button className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          )}

          {messages.length === 0 && (
            <div className="empty-chat">
              <span>✦</span>
              <p>This conversation is ready for its first message.</p>
            </div>
          )}

          {messages.map((message) => (
            <article
              key={message.id}
              className={message.authorId === me ? 'message mine' : 'message'}
            >
              <div className="avatar">{message.authorUsername.slice(0, 1).toUpperCase()}</div>
              <div className="message-content">
                <div className="message-meta">
                  <strong>{message.authorUsername}</strong>
                  <time dateTime={message.createdAt}>
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
            onClick={() => {
              const list = listRef.current;
              if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
            }}
          >
            {unseen ? 'New messages' : 'Jump to latest'} ↓
          </button>
        )}
      </div>

      <div className="typing-line">
        {typingNames.length > 0
          ? `${typingNames.join(', ')} ${typingNames.length === 1 ? 'is' : 'are'} typing…`
          : ' '}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          value={body}
          maxLength={maxMessageLength}
          placeholder={`Message ${active.type === 'room' ? `#${active.name}` : active.name}`}
          onChange={(event) => {
            setBody(event.target.value);
            onTyping();
          }}
        />
        <button aria-label="Send message" disabled={!body.trim()}>
          ↑
        </button>
      </form>
    </section>
  );
}
