import { useMemo } from 'react';
import type { DmSummary, RoomSummary } from '@chateria/protocol';
import { targetKey, useChat, type Target } from '../store.ts';

export function Sidebar({
  onSelectRoom,
  onSelectDm,
  onCreateRoom,
  onNewDm,
  onLogout,
}: {
  onSelectRoom: (room: RoomSummary) => void;
  onSelectDm: (dm: DmSummary) => void;
  onCreateRoom: () => void;
  onNewDm: () => void;
  onLogout: () => void;
}) {
  const rooms = useChat((state) => state.rooms);
  const dms = useChat((state) => state.dms);
  const people = useChat((state) => state.people);
  const presence = useChat((state) => state.presence);
  const active = useChat((state) => state.active);
  const unread = useChat((state) => state.unread);
  const connection = useChat((state) => state.connection);
  const session = useChat((state) => state.session);

  const others = useMemo(
    () => people.filter((person) => person.id !== session?.user.id),
    [people, session],
  );

  const isActive = (target: Pick<Target, 'type' | 'id'>): boolean =>
    active !== null && active.type === target.type && active.id === target.id;

  const badge = (target: Pick<Target, 'type' | 'id'>): number =>
    unread[targetKey(target)] ?? 0;

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="mark small">C</div>
        <strong>Chateria</strong>
        <span className={`conn ${connection}`} title={`Connection: ${connection}`} />
      </div>

      <nav>
        <div className="nav-heading">
          <span>Rooms</span>
          <button aria-label="Create room" onClick={onCreateRoom}>
            +
          </button>
        </div>
        <div className="nav-list">
          {rooms.map((room) => (
            <button
              key={room.id}
              className={isActive({ type: 'room', id: room.id }) ? 'nav-item active' : 'nav-item'}
              onClick={() => onSelectRoom(room)}
            >
              <span className="hash">#</span>
              <span className="nav-name">{room.name}</span>
              {badge({ type: 'room', id: room.id }) > 0 && (
                <em className="badge">{badge({ type: 'room', id: room.id })}</em>
              )}
              <small title={`${room.memberCount} members`}>{room.memberCount}</small>
            </button>
          ))}
          {rooms.length === 0 && <p className="empty-small">No rooms yet</p>}
        </div>

        <div className="nav-heading">
          <span>Direct messages</span>
          <button aria-label="New direct message" onClick={onNewDm}>
            +
          </button>
        </div>
        <div className="nav-list">
          {dms.map((dm) => (
            <button
              key={dm.conversationId}
              className={
                isActive({ type: 'dm', id: dm.conversationId }) ? 'nav-item active' : 'nav-item'
              }
              onClick={() => onSelectDm(dm)}
            >
              <span className={`presence ${presence[dm.otherUser.id] ?? 'offline'}`} />
              <span className="nav-name">{dm.otherUser.username}</span>
              {badge({ type: 'dm', id: dm.conversationId }) > 0 && (
                <em className="badge">{badge({ type: 'dm', id: dm.conversationId })}</em>
              )}
            </button>
          ))}
          {dms.length === 0 && <p className="empty-small">No conversations yet</p>}
        </div>

        <div className="nav-heading">
          <span>People</span>
        </div>
        <div className="nav-list presence-list">
          {others.map((person) => (
            <div key={person.id} className="presence-row">
              <span className={`presence ${presence[person.id] ?? 'offline'}`} />
              <span className="nav-name">{person.username}</span>
            </div>
          ))}
          {others.length === 0 && <p className="empty-small">Nobody else yet</p>}
        </div>
      </nav>

      <button className="logout" onClick={onLogout}>
        Sign out{session ? ` · ${session.user.username}` : ''}
      </button>
    </aside>
  );
}
