import { useState, type FormEvent } from 'react';
import type { RoomSummary } from '@chateria/protocol';
import type { Api } from '../api.ts';
import { Modal } from './Modal.tsx';

export function CreateRoomModal({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: (room: RoomSummary) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onCreated(await api.createRoom(name));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <Modal title="Create a room" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Room name
          <input
            value={name}
            maxLength={100}
            placeholder="design-critique"
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </form>
    </Modal>
  );
}
