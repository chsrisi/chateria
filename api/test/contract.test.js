import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { messageFromRow, pagination, parsePositiveId } from '../src/format.js';

test('IDs accept only safe positive integers', () => {
  assert.equal(parsePositiveId('42'), 42);
  assert.equal(parsePositiveId(1), 1);
  for (const value of [0, -1, '1.2', 'abc', '', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parsePositiveId(value), null);
  }
});

test('pagination defaults to 50 and caps at 100', () => {
  assert.deepEqual(pagination({}), { limit: 50, before: null, invalidBefore: false });
  assert.equal(pagination({ limit: '500' }).limit, 100);
  assert.equal(pagination({ limit: '-2' }).limit, 50);
  assert.deepEqual(pagination({ before: '17', limit: '10' }), { limit: 10, before: 17, invalidBefore: false });
  assert.equal(pagination({ before: 'nope' }).invalidBefore, true);
});

test('message rows are exposed in the contract shape with ISO timestamps', () => {
  const message = messageFromRow({
    id: '9', body: '<script>alert(1)</script>', author_id: 2,
    author_username: 'Ada', created_at: '2026-01-01T00:00:00Z',
    room_id: 3, conversation_id: null,
  });
  assert.deepEqual(message, {
    id: 9, body: '<script>alert(1)</script>', authorId: 2, authorUsername: 'Ada',
    createdAt: '2026-01-01T00:00:00.000Z', roomId: 3, conversationId: null,
  });
});

test('JWT verification accepts signed HS256 and rejects none or expired tokens', async () => {
  process.env.JWT_SECRET = 'unit-test-secret';
  const { verifyToken } = await import(`../src/auth.js?test=${Date.now()}`);
  const valid = jwt.sign({ sub: '7', username: 'Lin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1m' });
  assert.deepEqual(verifyToken(valid), { id: 7, username: 'Lin' });

  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: '7' })).toString('base64url')}.`;
  assert.throws(() => verifyToken(unsigned));
  const expired = jwt.sign({ sub: '7', exp: 1 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  assert.throws(() => verifyToken(expired));
});
