import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiStats } from '../../main/api/server.ts';
import type { LogEntry } from '../../main/ipc.ts';
import type { Settings } from '../../main/settings.ts';

const STATUS_LABEL: Record<ApiStats['status'], string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  error: 'Error',
};

function StatusDot({ status }: { status: ApiStats['status'] }) {
  return <span className={`dot ${status}`} aria-hidden />;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
    </div>
  );
}

export default function App() {
  const [stats, setStats] = useState<ApiStats | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    void (async () => {
      const [initialSettings, initialStats, history] = await Promise.all([
        window.chateria.getSettings(),
        window.chateria.getStats(),
        window.chateria.getLog(),
      ]);
      setSettings(initialSettings);
      setDraft(initialSettings);
      setStats(initialStats);
      setLog(history);
    })();

    const offStats = window.chateria.onStats(setStats);
    const offLog = window.chateria.onLog((entry) =>
      setLog((old) => [...old, entry].slice(-500)),
    );
    return () => {
      offStats();
      offLog();
    };
  }, []);

  // Follow the tail only while the operator has not scrolled up to read.
  useEffect(() => {
    const element = logRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [log]);

  const run = useCallback(async (action: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setNotice('');
    try {
      await action();
      if (message) setNotice(message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!stats || !settings || !draft) {
    return <main className="loading">Starting up…</main>;
  }

  const running = stats.status === 'running';
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  async function save(): Promise<void> {
    const saved = await window.chateria.saveSettings(draft!);
    setSettings(saved);
    setDraft(saved);
  }

  return (
    <main className="shell">
      <header className="titlebar">
        <div className="identity">
          <div className="mark">C</div>
          <div>
            <h1>Chateria Server</h1>
            <p className="sub">
              <StatusDot status={stats.status} />
              {STATUS_LABEL[stats.status]}
              {stats.port !== null && ` · port ${stats.port}`}
            </p>
          </div>
        </div>

        <div className="actions">
          {running ? (
            <>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void run(() => window.chateria.restart())}
              >
                Restart
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() => void run(() => window.chateria.stop())}
              >
                Stop
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(() => window.chateria.start())}
            >
              Start server
            </button>
          )}
        </div>
      </header>

      {stats.error && (
        <p className="banner error" role="alert">
          {stats.error}
        </p>
      )}
      {notice && <p className="banner">{notice}</p>}

      <section className="stats">
        <Stat label="Open sockets" value={stats.sockets} />
        <Stat label="Online users" value={stats.connectedUsers.length} />
        <Stat label="PostgreSQL" value={stats.databaseVersion ?? '—'} />
        <Stat label="Signing key" value={stats.keyId ? `${stats.keyId.slice(0, 10)}…` : '—'} />
      </section>

      <div className="columns">
        <section className="panel">
          <h2>Settings</h2>
          <p className="hint">
            Changes apply on the next start. The API is stopped while you edit.
          </p>

          <label>
            Database URL
            <input
              value={draft.databaseUrl}
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, databaseUrl: event.target.value })}
            />
          </label>

          <div className="row">
            <label>
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) =>
                  setDraft({ ...draft, port: Number(event.target.value) || draft.port })
                }
              />
            </label>
            <label>
              Token lifetime
              <input
                value={draft.tokenTtl}
                onChange={(event) => setDraft({ ...draft, tokenTtl: event.target.value })}
              />
            </label>
          </div>

          <label>
            Max message length
            <input
              type="number"
              min={1}
              value={draft.maxMessageLength}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  maxMessageLength: Number(event.target.value) || draft.maxMessageLength,
                })
              }
            />
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.autoStart}
              onChange={(event) => setDraft({ ...draft, autoStart: event.target.checked })}
            />
            Start the API automatically on launch
          </label>

          <div className="row end">
            <button className="ghost" disabled={!dirty} onClick={() => setDraft(settings)}>
              Discard
            </button>
            <button
              className="primary"
              disabled={!dirty || busy}
              onClick={() => void run(save, 'Settings saved.')}
            >
              Save
            </button>
          </div>

          <hr />

          <h2>Signing key</h2>
          <p className="hint">
            Tokens are ES256 (ECDSA P-256). The private key stays on this machine; clients
            can fetch the public half from <code>/.well-known/jwks.json</code>.
          </p>
          <div className="row end">
            <button className="ghost" onClick={() => void window.chateria.openKeyFolder()}>
              Reveal key folder
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.chateria.rotateKey(),
                  'Key rotated. Every existing session must sign in again.',
                )
              }
            >
              Rotate key
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Connected users</h2>
          {stats.connectedUsers.length === 0 ? (
            <p className="empty">Nobody is connected.</p>
          ) : (
            <ul className="users">
              {stats.connectedUsers.map((user) => (
                <li key={user.id}>
                  <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
                  <span className="username">{user.username}</span>
                  <small>
                    {user.connections} {user.connections === 1 ? 'window' : 'windows'}
                  </small>
                </li>
              ))}
            </ul>
          )}

          <h2>Activity</h2>
          <div
            className="log"
            ref={logRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {log.length === 0 && <p className="empty">No activity yet.</p>}
            {log.map((entry, index) => (
              <p key={`${entry.at}-${index}`} className={`line ${entry.level}`}>
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <span>{entry.message}</span>
              </p>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
