import { useEffect, useState } from 'react';
import type { PublicUser } from '@chateria/protocol';
import type { Api } from '../api.ts';
import { Modal } from './Modal.tsx';

export function NewDmModal({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: (conversationId: number, user: PublicUser) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .users(query)
        .then((users) => !cancelled && setResults(users))
        .catch((caught: unknown) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, query]);

  async function choose(user: PublicUser): Promise<void> {
    try {
      const { conversationId } = await api.createDm(user.id);
      onCreated(conversationId, user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <Modal title="New direct message" onClose={onClose}>
      <label>
        Search people
        <input
          value={query}
          placeholder="Start typing a username"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="user-results">
        {results.map((user) => (
          <button key={user.id} className="user-result" onClick={() => void choose(user)}>
            <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            {user.username}
          </button>
        ))}
        {results.length === 0 && <p className="empty-small">No matching people</p>}
      </div>
    </Modal>
  );
}
