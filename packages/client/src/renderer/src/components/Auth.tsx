import { useEffect, useState, type FormEvent } from 'react';
import type { AuthResult } from '@chateria/protocol';
import { ApiError, createApi } from '../api.ts';

type Mode = 'login' | 'register';

export function Auth({
  serverUrl,
  onServerUrlChange,
  onAuthenticated,
}: {
  serverUrl: string;
  onServerUrlChange: (url: string) => Promise<void>;
  onAuthenticated: (result: AuthResult, serverUrl: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [address, setAddress] = useState(serverUrl);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setAddress(serverUrl), [serverUrl]);

  // Probe the address as it settles so a wrong port is obvious before signing in.
  useEffect(() => {
    let cancelled = false;
    setReachable(null);
    const timer = setTimeout(() => {
      createApi(address)
        .info()
        .then(() => !cancelled && setReachable(true))
        .catch(() => !cancelled && setReachable(false));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onServerUrlChange(address);
      const api = createApi(address);
      const result = await (mode === 'login'
        ? api.login({ username, password })
        : api.register({ username, password }));
      onAuthenticated(result, address);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="mark large">C</div>
        <p className="eyebrow">Real-time conversations</p>
        <h1>{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</h1>
        <p className="muted">Rooms for everyone. Messages for just the two of you.</p>

        <form onSubmit={(event) => void submit(event)}>
          <label>
            Server
            <input
              value={address}
              spellCheck={false}
              placeholder="http://127.0.0.1:3000"
              onChange={(event) => setAddress(event.target.value)}
            />
            <small className={`probe ${reachable === false ? 'bad' : reachable ? 'ok' : ''}`}>
              {reachable === null
                ? 'Checking…'
                : reachable
                  ? 'Server reachable'
                  : 'No Chateria server at this address'}
            </small>
          </label>

          <label>
            Username
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button className="primary full" disabled={busy}>
            {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>

        <button
          className="text-button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError('');
          }}
        >
          {mode === 'login'
            ? 'New here? Create an account'
            : 'Already have an account? Log in'}
        </button>
      </section>
    </main>
  );
}
