/**
 * The wire contract shared by the Chateria server app and client app.
 *
 * Both Electron apps compile this source directly (the package has no build
 * step), so a change here is a compile error on whichever side has not caught
 * up. Keep every field serialisable: these types cross both HTTP and WebSocket.
 */

export const PROTOCOL_VERSION = 2 as const;

/* ------------------------------------------------------------------ *
 * Entities
 * ------------------------------------------------------------------ */

export interface PublicUser {
  id: number;
  username: string;
}

export interface RoomSummary {
  id: number;
  name: string;
  memberCount: number;
  /** Whether the *requesting* user is a member. Absent on broadcasts. */
  joined?: boolean;
}

export interface Message {
  id: number;
  body: string;
  authorId: number;
  authorUsername: string;
  /** ISO-8601, always assigned by the server. */
  createdAt: string;
  roomId: number | null;
  conversationId: number | null;
}

export interface DmSummary {
  conversationId: number;
  otherUser: PublicUser;
  lastMessage: Message | null;
}

export type PresenceStatus = 'online' | 'offline';

export interface PresenceEntry {
  userId: number;
  status: PresenceStatus;
}

/* ------------------------------------------------------------------ *
 * REST
 * ------------------------------------------------------------------ */

export interface Credentials {
  username: string;
  password: string;
}

export interface AuthResult {
  token: string;
  user: PublicUser;
  /** Seconds until `token` expires, so the client can refresh or warn. */
  expiresIn: number;
}

export interface MessagePage {
  messages: Message[];
  /** Cursor for the next (older) page, or null when the history is exhausted. */
  nextCursor: number | null;
}

export interface ErrorResponse {
  error: string;
}

export interface ServerInfo {
  name: 'chateria';
  protocolVersion: number;
  maxMessageLength: number;
  /** JWT signing algorithm. ES256 (ECDSA P-256 + SHA-256). */
  algorithm: 'ES256';
}

/* ------------------------------------------------------------------ *
 * WebSocket: client -> server
 * ------------------------------------------------------------------ */

export interface RoomSubscribeFrame {
  type: 'room:subscribe';
  roomId: number;
}

export interface RoomUnsubscribeFrame {
  type: 'room:unsubscribe';
  roomId: number;
}

export interface TypingStartFrame {
  type: 'typing:start';
  roomId: number;
}

export interface MessageSendFrame {
  type: 'message:send';
  body: string;
  /** Exactly one of roomId / conversationId must be set. */
  roomId?: number | null;
  conversationId?: number | null;
  /**
   * Optional client-generated id echoed back on the resulting `message:new`,
   * letting the sender reconcile an optimistic bubble with the stored row.
   */
  clientNonce?: string;
}

export interface PingFrame {
  type: 'ping';
}

export type ClientFrame =
  | RoomSubscribeFrame
  | RoomUnsubscribeFrame
  | TypingStartFrame
  | MessageSendFrame
  | PingFrame;

export type ClientFrameType = ClientFrame['type'];

/* ------------------------------------------------------------------ *
 * WebSocket: server -> client
 * ------------------------------------------------------------------ */

export interface WelcomeEvent {
  type: 'welcome';
  user: PublicUser;
  protocolVersion: number;
  maxMessageLength: number;
}

export interface MessageNewEvent {
  type: 'message:new';
  message: Message;
  /** Present only on the frame delivered to the original sender. */
  clientNonce?: string;
}

export interface PresenceUpdateEvent {
  type: 'presence:update';
  userId: number;
  username: string;
  status: PresenceStatus;
}

export interface TypingEvent {
  type: 'typing';
  roomId: number;
  userId: number;
  username: string;
}

/* --- state broadcasts: keep every client's sidebar live without refetching --- */

export interface RoomCreatedEvent {
  type: 'room:created';
  room: RoomSummary;
  createdBy: PublicUser;
}

export interface RoomMemberJoinedEvent {
  type: 'room:member_joined';
  roomId: number;
  user: PublicUser;
  memberCount: number;
}

export interface RoomMemberLeftEvent {
  type: 'room:member_left';
  roomId: number;
  userId: number;
  memberCount: number;
}

export interface DmCreatedEvent {
  type: 'dm:created';
  conversation: DmSummary;
}

export interface UserRegisteredEvent {
  type: 'user:registered';
  user: PublicUser;
}

export interface ServerErrorEvent {
  type: 'error';
  error: string;
  /** Echoes the frame that caused it, when the server can attribute it. */
  inReplyTo?: ClientFrameType;
}

export interface PongEvent {
  type: 'pong';
}

export type ServerEvent =
  | WelcomeEvent
  | MessageNewEvent
  | PresenceUpdateEvent
  | TypingEvent
  | RoomCreatedEvent
  | RoomMemberJoinedEvent
  | RoomMemberLeftEvent
  | DmCreatedEvent
  | UserRegisteredEvent
  | ServerErrorEvent
  | PongEvent;

export type ServerEventType = ServerEvent['type'];

/** Narrowing helper shared by both renderers. */
export function isServerEvent<T extends ServerEventType>(
  event: ServerEvent,
  type: T,
): event is Extract<ServerEvent, { type: T }> {
  return event.type === type;
}

/* ------------------------------------------------------------------ *
 * Close codes
 * ------------------------------------------------------------------ */

export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_PROTOCOL_MISMATCH = 4426;
