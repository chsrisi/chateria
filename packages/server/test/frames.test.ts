import assert from 'node:assert/strict';
import test from 'node:test';
import { clientFrameSchema, createDmSchema, credentialsSchema } from '../src/main/api/frames.ts';

test('valid client frames parse', () => {
  for (const frame of [
    { type: 'ping' },
    { type: 'room:subscribe', roomId: 3 },
    { type: 'room:unsubscribe', roomId: 3 },
    { type: 'typing:start', roomId: 3 },
    { type: 'message:send', body: 'hi', roomId: 3 },
    { type: 'message:send', body: 'hi', conversationId: 4, clientNonce: 'abc' },
  ]) {
    assert.equal(clientFrameSchema.safeParse(frame).success, true, JSON.stringify(frame));
  }
});

test('hostile or malformed frames are rejected before any handler runs', () => {
  for (const frame of [
    null,
    'string',
    42,
    {},
    { type: 'unknown' },
    { type: 'room:subscribe' },
    { type: 'room:subscribe', roomId: 0 },
    { type: 'room:subscribe', roomId: -1 },
    { type: 'room:subscribe', roomId: '3' },
    { type: 'room:subscribe', roomId: 1.5 },
    { type: 'message:send', roomId: 3 },
    { type: 'message:send', body: 42, roomId: 3 },
  ]) {
    assert.equal(clientFrameSchema.safeParse(frame).success, false, JSON.stringify(frame));
  }
});

test('credentials are trimmed and bounded', () => {
  const parsed = credentialsSchema.safeParse({ username: '  ada  ', password: 'secret' });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.username, 'ada');

  assert.equal(credentialsSchema.safeParse({ username: '   ', password: 'x' }).success, false);
  assert.equal(
    credentialsSchema.safeParse({ username: 'a'.repeat(65), password: 'x' }).success,
    false,
  );
  assert.equal(
    credentialsSchema.safeParse({ username: 'a', password: 'x'.repeat(1025) }).success,
    false,
  );
  // Passwords are opaque: whitespace is meaningful and must not be trimmed.
  assert.equal(credentialsSchema.parse({ username: 'a', password: ' pw ' }).password, ' pw ');
});

test('dm creation requires a positive integer user id', () => {
  assert.equal(createDmSchema.safeParse({ userId: 5 }).success, true);
  for (const userId of [0, -1, '5', 1.5, null]) {
    assert.equal(createDmSchema.safeParse({ userId }).success, false);
  }
});
