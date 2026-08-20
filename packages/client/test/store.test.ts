import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { ServerEvent } from '@chateria/protocol';
import { applyServerEvent, chat, targetKey, useChat } from '../src/renderer/src/store.ts';

const ME = { id: 1, username: 'ada' };
const OTHER = { id: 2, username: 'lin' };

const message = (over: Partial<import('@chateria/protocol').Message> = {}) => ({
  id: 10,
  body: 'hello',
  authorId: OTHER.id,
  authorUsername: OTHER.username,
  createdAt: '2026-01-01T00:00:00.000Z',
  roomId: 5,
  conversationId: null,
  ...over,
});

beforeEach(() => {
  chat.reset();
  chat.setSession({ token: 't', user: ME });
});

test('room:created appears for everyone, joined only for its creator', () => {
  applyServerEvent({
    type: 'room:created',
    room: { id: 5, name: 'design', memberCount: 1 },
    createdBy: OTHER,
  });
  const [room] = useChat.getState().rooms;
  assert.equal(room?.name, 'design');
  assert.equal(room?.joined, false, 'someone else created it');

  applyServerEvent({
    type: 'room:created',
    room: { id: 6, name: 'mine', memberCount: 1 },
    createdBy: ME,
  });
  assert.equal(useChat.getState().rooms.find((r) => r.id === 6)?.joined, true);
  // The creator is learned about even if they were not in the people list.
  assert.ok(useChat.getState().people.some((p) => p.id === OTHER.id));
});

test('membership broadcasts update the count and only my own joined flag', () => {
  applyServerEvent({
    type: 'room:created',
    room: { id: 5, name: 'design', memberCount: 1 },
    createdBy: OTHER,
  });

  applyServerEvent({ type: 'room:member_joined', roomId: 5, user: OTHER, memberCount: 2 });
  let room = useChat.getState().rooms[0]!;
  assert.equal(room.memberCount, 2);
  assert.equal(room.joined, false, "another user joining must not mark the room as mine");

  applyServerEvent({ type: 'room:member_joined', roomId: 5, user: ME, memberCount: 3 });
  room = useChat.getState().rooms[0]!;
  assert.equal(room.memberCount, 3);
  assert.equal(room.joined, true);

  applyServerEvent({ type: 'room:member_left', roomId: 5, userId: OTHER.id, memberCount: 2 });
  assert.equal(useChat.getState().rooms[0]!.joined, true, 'someone else leaving is not me');

  applyServerEvent({ type: 'room:member_left', roomId: 5, userId: ME.id, memberCount: 1 });
  assert.equal(useChat.getState().rooms[0]!.joined, false);
  assert.equal(useChat.getState().rooms[0]!.memberCount, 1);
});

test('dm:created is added once and is idempotent', () => {
  const event: ServerEvent = {
    type: 'dm:created',
    conversation: { conversationId: 3, otherUser: OTHER, lastMessage: null },
  };
  applyServerEvent(event);
  applyServerEvent(event);
  assert.equal(useChat.getState().dms.length, 1);
  assert.ok(useChat.getState().people.some((p) => p.id === OTHER.id));
});

test('messages land in the open conversation and are de-duplicated', () => {
  chat.openTarget({ type: 'room', id: 5, name: 'design' }, { messages: [], nextCursor: null });

  applyServerEvent({ type: 'message:new', message: message() });
  applyServerEvent({ type: 'message:new', message: message() });
  assert.equal(useChat.getState().messages.length, 1, 'a repeated id must not duplicate');
  assert.equal(useChat.getState().unread[targetKey({ type: 'room', id: 5 })] ?? 0, 0);
});

test('messages for a closed conversation raise its unread count instead', () => {
  chat.openTarget({ type: 'room', id: 9, name: 'other' }, { messages: [], nextCursor: null });

  applyServerEvent({ type: 'message:new', message: message({ id: 11 }) });
  applyServerEvent({ type: 'message:new', message: message({ id: 12 }) });
  assert.equal(useChat.getState().messages.length, 0, 'not the open room');
  assert.equal(useChat.getState().unread[targetKey({ type: 'room', id: 5 })], 2);

  // My own message elsewhere (another window) must not mark itself unread.
  applyServerEvent({ type: 'message:new', message: message({ id: 13, authorId: ME.id }) });
  assert.equal(useChat.getState().unread[targetKey({ type: 'room', id: 5 })], 2);
});

test('opening a target clears its unread badge', () => {
  applyServerEvent({ type: 'message:new', message: message({ id: 20 }) });
  assert.equal(useChat.getState().unread[targetKey({ type: 'room', id: 5 })], 1);

  chat.openTarget({ type: 'room', id: 5, name: 'design' }, { messages: [], nextCursor: null });
  assert.equal(useChat.getState().unread[targetKey({ type: 'room', id: 5 })], 0);
});

test('presence and registrations keep the people list complete', () => {
  applyServerEvent({ type: 'user:registered', user: OTHER });
  assert.equal(useChat.getState().presence[OTHER.id], 'offline');

  applyServerEvent({
    type: 'presence:update',
    userId: OTHER.id,
    username: OTHER.username,
    status: 'online',
  });
  assert.equal(useChat.getState().presence[OTHER.id], 'online');
  assert.equal(
    useChat.getState().people.filter((p) => p.id === OTHER.id).length,
    1,
    'the person must not be added twice',
  );
});

test('typing indicators are scoped to the open room and expire', () => {
  chat.openTarget({ type: 'room', id: 5, name: 'design' }, { messages: [], nextCursor: null });

  applyServerEvent({ type: 'typing', roomId: 9, userId: OTHER.id, username: OTHER.username });
  assert.deepEqual(useChat.getState().typing, {}, 'a different room must be ignored');

  applyServerEvent({ type: 'typing', roomId: 5, userId: ME.id, username: ME.username });
  assert.deepEqual(useChat.getState().typing, {}, 'my own typing must be ignored');

  applyServerEvent({ type: 'typing', roomId: 5, userId: OTHER.id, username: OTHER.username });
  assert.equal(useChat.getState().typing[OTHER.id]?.username, OTHER.username);

  chat.expireTyping();
  assert.ok(useChat.getState().typing[OTHER.id], 'still fresh');

  useChat.setState({ typing: { [OTHER.id]: { username: OTHER.username, expiresAt: 0 } } });
  chat.expireTyping();
  assert.deepEqual(useChat.getState().typing, {});
});
