import { create } from 'zustand';
import type {
  ClientFrame,
  DmSummary,
  Message,
  PresenceStatus,
  PublicUser,
  RoomSummary,
  ServerEvent,
} from '@chateria/protocol';

export type Target =
  | { type: 'room'; id: number; name: string }
  | { type: 'dm'; id: number; name: string };

export type ConnectionStatus = 'offline' | 'connecting' | 'online';

export interface TypingEntry {
  username: string;
  expiresAt: number;
}

interface ChatState {
  session: { token: string; user: PublicUser } | null;
  serverUrl: string;
  connection: ConnectionStatus;

  rooms: RoomSummary[];
  dms: DmSummary[];
  people: PublicUser[];
  presence: Record<number, PresenceStatus>;

  active: Target | null;
  messages: Message[];
  nextCursor: number | null;
  typing: Record<number, TypingEntry>;
  /** Conversation/room key -> unread count while it is not the active target. */
  unread: Record<string, number>;
  notice: string;

  /** Set by the realtime layer so components can send without prop drilling. */
  send: (frame: ClientFrame) => void;
}

export const targetKey = (target: Pick<Target, 'type' | 'id'>): string =>
  `${target.type}:${target.id}`;

const initial = {
  session: null,
  serverUrl: '',
  connection: 'offline',
  rooms: [],
  dms: [],
  people: [],
  presence: {},
  active: null,
  messages: [],
  nextCursor: null,
  typing: {},
  unread: {},
  notice: '',
} satisfies Omit<ChatState, 'send'>;

export const useChat = create<ChatState>(() => ({ ...initial, send: () => {} }));

const set = useChat.setState;
const get = useChat.getState;

/* ------------------------------------------------------------------ *
 * Plain actions
 * ------------------------------------------------------------------ */

export const chat = {
  reset: (): void => set({ ...initial, send: () => {} }),

  setSession: (session: ChatState['session']): void => set({ session }),
  setServerUrl: (serverUrl: string): void => set({ serverUrl }),
  setConnection: (connection: ConnectionStatus): void => set({ connection }),
  setNotice: (notice: string): void => set({ notice }),
  setSend: (send: ChatState['send']): void => set({ send }),

  setDirectory: (data: {
    rooms: RoomSummary[];
    dms: DmSummary[];
    people: PublicUser[];
    presence: Record<number, PresenceStatus>;
  }): void => set(data),

  openTarget: (target: Target, page: { messages: Message[]; nextCursor: number | null }): void =>
    set((state) => ({
      active: target,
      messages: page.messages,
      nextCursor: page.nextCursor,
      typing: {},
      unread: { ...state.unread, [targetKey(target)]: 0 },
    })),

  closeTarget: (): void => set({ active: null, messages: [], nextCursor: null, typing: {} }),

  prependPage: (page: { messages: Message[]; nextCursor: number | null }): void =>
    set((state) => ({
      messages: [...page.messages, ...state.messages],
      nextCursor: page.nextCursor,
    })),

  expireTyping: (): void =>
    set((state) => {
      const now = Date.now();
      const live = Object.entries(state.typing).filter(([, entry]) => entry.expiresAt > now);
      if (live.length === Object.keys(state.typing).length) return state;
      return { typing: Object.fromEntries(live) };
    }),
};

/* ------------------------------------------------------------------ *
 * Server events
 * ------------------------------------------------------------------ */

const TYPING_TTL_MS = 1_800;

function upsertPerson(people: PublicUser[], user: PublicUser): PublicUser[] {
  return people.some((person) => person.id === user.id) ? people : [...people, user];
}

function bumpUnread(
  state: ChatState,
  target: Pick<Target, 'type' | 'id'>,
): ChatState['unread'] {
  const key = targetKey(target);
  return { ...state.unread, [key]: (state.unread[key] ?? 0) + 1 };
}

/**
 * The single reducer for everything the server pushes. Because the API
 * broadcasts state changes (rooms created, members joining and leaving, new
 * DMs, new accounts) this is what keeps every window's sidebar correct without
 * any polling or refetch-after-mutation.
 */
export function applyServerEvent(event: ServerEvent): void {
  const state = get();
  const me = state.session?.user.id;

  switch (event.type) {
    case 'welcome': {
      set({ connection: 'online' });
      return;
    }

    case 'message:new': {
      const { message } = event;
      const isActive =
        state.active !== null &&
        ((state.active.type === 'room' && message.roomId === state.active.id) ||
          (state.active.type === 'dm' && message.conversationId === state.active.id));

      set((current) => ({
        messages: isActive
          ? current.messages.some((existing) => existing.id === message.id)
            ? current.messages
            : [...current.messages, message]
          : current.messages,
        dms: current.dms.map((dm) =>
          dm.conversationId === message.conversationId ? { ...dm, lastMessage: message } : dm,
        ),
        unread:
          isActive || message.authorId === me
            ? current.unread
            : bumpUnread(
                current,
                message.roomId !== null
                  ? { type: 'room', id: message.roomId }
                  : { type: 'dm', id: message.conversationId! },
              ),
      }));
      return;
    }

    case 'presence:update': {
      set((current) => ({
        presence: { ...current.presence, [event.userId]: event.status },
        people: upsertPerson(current.people, { id: event.userId, username: event.username }),
      }));
      return;
    }

    case 'typing': {
      if (state.active?.type !== 'room' || state.active.id !== event.roomId) return;
      if (event.userId === me) return;
      set((current) => ({
        typing: {
          ...current.typing,
          [event.userId]: {
            username: event.username,
            expiresAt: Date.now() + TYPING_TTL_MS,
          },
        },
      }));
      return;
    }

    /* --- state broadcasts --- */

    case 'room:created': {
      set((current) => ({
        rooms: current.rooms.some((room) => room.id === event.room.id)
          ? current.rooms
          : [...current.rooms, { ...event.room, joined: event.createdBy.id === me }].sort(
              (a, b) => a.id - b.id,
            ),
        people: upsertPerson(current.people, event.createdBy),
      }));
      return;
    }

    case 'room:member_joined': {
      set((current) => ({
        rooms: current.rooms.map((room) =>
          room.id === event.roomId
            ? {
                ...room,
                memberCount: event.memberCount,
                joined: event.user.id === me ? true : room.joined,
              }
            : room,
        ),
        people: upsertPerson(current.people, event.user),
      }));
      return;
    }

    case 'room:member_left': {
      set((current) => ({
        rooms: current.rooms.map((room) =>
          room.id === event.roomId
            ? {
                ...room,
                memberCount: event.memberCount,
                joined: event.userId === me ? false : room.joined,
              }
            : room,
        ),
      }));
      return;
    }

    case 'dm:created': {
      set((current) => ({
        dms: current.dms.some(
          (dm) => dm.conversationId === event.conversation.conversationId,
        )
          ? current.dms
          : [event.conversation, ...current.dms],
        people: upsertPerson(current.people, event.conversation.otherUser),
      }));
      return;
    }

    case 'user:registered': {
      if (event.user.id === me) return;
      set((current) => ({
        people: upsertPerson(current.people, event.user),
        presence: { ...current.presence, [event.user.id]: 'offline' },
      }));
      return;
    }

    case 'error': {
      set({ notice: event.error });
      return;
    }

    case 'pong':
      return;
  }
}
