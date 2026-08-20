import assert from 'node:assert/strict';
import test from 'node:test';
import { ttlToSeconds } from '../src/main/api/config.ts';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  messageFromRow,
  pagination,
  parsePositiveId,
} from '../src/main/api/format.ts';

test('ids accept only safe positive integers', () => {
  assert.equal(parsePositiveId('42'), 42);
  assert.equal(parsePositiveId(1), 1);
  for (const value of [0, -1, '1.2', 'abc', '', null, undefined, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parsePositiveId(value), null, `expected ${String(value)} to be rejected`);
  }
});

test('pagination defaults, caps, and flags bad cursors', () => {
  assert.deepEqual(pagination({}), {
    limit: DEFAULT_PAGE_SIZE,
    before: null,
    invalidBefore: false,
  });
  assert.equal(pagination({ limit: '500' }).limit, MAX_PAGE_SIZE);
  assert.equal(pagination({ limit: '-2' }).limit, DEFAULT_PAGE_SIZE);
  assert.deepEqual(pagination({ before: '17', limit: '10' }), {
    limit: 10,
    before: 17,
    invalidBefore: false,
  });
  assert.equal(pagination({ before: 'nope' }).invalidBefore, true);
  // An empty cursor means "no cursor", not "bad cursor".
  assert.equal(pagination({ before: '' }).invalidBefore, false);
});

test('message rows become the wire shape with ISO timestamps', () => {
  const message = messageFromRow({
    id: '9',
    body: '<script>alert(1)</script>',
    author_id: 2,
    author_username: 'Ada',
    created_at: '2026-01-01T00:00:00Z',
    room_id: 3,
    conversation_id: null,
  });
  assert.deepEqual(message, {
    id: 9,
    body: '<script>alert(1)</script>',
    authorId: 2,
    authorUsername: 'Ada',
    createdAt: '2026-01-01T00:00:00.000Z',
    roomId: 3,
    conversationId: null,
  });
});

test('token lifetimes convert to seconds', () => {
  assert.equal(ttlToSeconds('30s'), 30);
  assert.equal(ttlToSeconds('15m'), 900);
  assert.equal(ttlToSeconds('12h'), 43_200);
  assert.equal(ttlToSeconds('7d'), 604_800);
  assert.equal(ttlToSeconds('garbage'), 604_800);
});
