import assert from 'node:assert/strict';
import WebSocket from 'ws';

const apiBase = process.env.TEST_API_URL || 'http://127.0.0.1:3000/api';
const wsBase = process.env.TEST_WS_URL || 'ws://127.0.0.1:3000/ws';

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json();
  return { status: response.status, body: payload };
}

async function register(username) {
  const result = await api('/auth/register', { method: 'POST', body: { username, password: 'correct horse battery staple' } });
  assert.equal(result.status, 201);
  return result.body;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`);
    const messages = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      const index = waiters.findIndex(({ predicate }) => predicate(frame));
      if (index >= 0) {
        const [{ resolve: done, timer }] = waiters.splice(index, 1);
        clearTimeout(timer);
        done(frame);
      } else messages.push(frame);
    });
    ws.once('error', reject);
    ws.once('open', () => {
      ws.waitFor = (predicate, timeout = 3000) => {
        const existing = messages.findIndex(predicate);
        if (existing >= 0) return Promise.resolve(messages.splice(existing, 1)[0]);
        return new Promise((done, fail) => {
          const waiter = { predicate, resolve: done };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            fail(new Error('Timed out waiting for WebSocket frame'));
          }, timeout);
          waiters.push(waiter);
        });
      };
      resolve(ws);
    });
  });
}

async function invalidTokenClosesWith4401() {
  const ws = new WebSocket(`${wsBase}?token=not-a-jwt`);
  const code = await new Promise((resolve, reject) => {
    ws.once('close', resolve);
    ws.once('error', () => {});
    setTimeout(() => reject(new Error('Invalid socket was not closed')), 3000);
  });
  assert.equal(code, 4401);
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const alice = await register(`alice-${suffix}`);
const bob = await register(`bob-${suffix}`);
const eve = await register(`eve-${suffix}`);

assert.deepEqual((await api('/me', { token: alice.token })).body, alice.user);
assert.equal((await api('/me')).status, 401);
await invalidTokenClosesWith4401();

const roomCreate = await api('/rooms', { token: alice.token, method: 'POST', body: { name: `room-${suffix}` } });
assert.equal(roomCreate.status, 201);
const roomId = roomCreate.body.id;
assert.equal((await api(`/rooms/${roomId}/messages`, { token: bob.token })).status, 403);
assert.equal((await api(`/rooms/${roomId}/join`, { token: bob.token, method: 'POST' })).status, 204);
assert.equal((await api(`/rooms/${roomId}/join`, { token: bob.token, method: 'POST' })).status, 204);
const room = (await api('/rooms', { token: alice.token })).body.find((item) => item.id === roomId);
assert.equal(room.memberCount, 2);

const aliceWs = await connect(alice.token);
const bobWs = await connect(bob.token);
const eveWs = await connect(eve.token);
aliceWs.send(JSON.stringify({ type: 'room:subscribe', roomId }));
bobWs.send(JSON.stringify({ type: 'room:subscribe', roomId }));

eveWs.send('{bad json');
assert.equal((await eveWs.waitFor((frame) => frame.type === 'error')).type, 'error');
eveWs.send(JSON.stringify({ type: 'ping' }));
assert.equal((await eveWs.waitFor((frame) => frame.type === 'pong')).type, 'pong');

const beforeSend = Date.now();
aliceWs.send(JSON.stringify({
  type: 'message:send', roomId, body: '<img src=x onerror=alert(1)>',
  authorId: eve.user.id, createdAt: '2000-01-01T00:00:00.000Z',
}));
const aliceRoomFrame = await aliceWs.waitFor((frame) => frame.type === 'message:new' && frame.message.roomId === roomId);
const bobRoomFrame = await bobWs.waitFor((frame) => frame.type === 'message:new' && frame.message.roomId === roomId);
assert.equal(aliceRoomFrame.message.id, bobRoomFrame.message.id);
assert.equal(aliceRoomFrame.message.authorId, alice.user.id);
assert.equal(aliceRoomFrame.message.body, '<img src=x onerror=alert(1)>');
assert.ok(Date.parse(aliceRoomFrame.message.createdAt) >= beforeSend);

eveWs.send(JSON.stringify({ type: 'message:send', roomId, body: 'not allowed' }));
assert.match((await eveWs.waitFor((frame) => frame.type === 'error')).error, /member/i);

for (const body of ['second', 'third']) {
  aliceWs.send(JSON.stringify({ type: 'message:send', roomId, body }));
  await aliceWs.waitFor((frame) => frame.type === 'message:new' && frame.message.body === body);
}
const newest = await api(`/rooms/${roomId}/messages?limit=2`, { token: alice.token });
assert.equal(newest.body.messages.length, 2);
assert.ok(newest.body.messages[0].id < newest.body.messages[1].id);
assert.notEqual(newest.body.nextCursor, null);
const older = await api(`/rooms/${roomId}/messages?limit=2&before=${newest.body.nextCursor}`, { token: alice.token });
assert.equal(older.body.messages.length, 1);
assert.equal(new Set([...older.body.messages, ...newest.body.messages].map((message) => message.id)).size, 3);

const dmFromAlice = await api('/dms', { token: alice.token, method: 'POST', body: { userId: bob.user.id } });
const dmFromBob = await api('/dms', { token: bob.token, method: 'POST', body: { userId: alice.user.id } });
assert.equal(dmFromAlice.status, 201);
assert.equal(dmFromAlice.body.conversationId, dmFromBob.body.conversationId);
assert.equal((await api('/dms', { token: alice.token, method: 'POST', body: { userId: alice.user.id } })).status, 400);
assert.ok((await api('/dms', { token: alice.token })).body.some((dm) => dm.conversationId === dmFromAlice.body.conversationId));
assert.equal((await api(`/dms/${dmFromAlice.body.conversationId}/messages`, { token: eve.token })).status, 403);

let leakedToEve = false;
const leakListener = (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type === 'message:new' && frame.message.conversationId === dmFromAlice.body.conversationId) leakedToEve = true;
};
eveWs.on('message', leakListener);
aliceWs.send(JSON.stringify({ type: 'message:send', conversationId: dmFromAlice.body.conversationId, body: 'private' }));
const aliceDmFrame = await aliceWs.waitFor((frame) => frame.type === 'message:new' && frame.message.body === 'private');
const bobDmFrame = await bobWs.waitFor((frame) => frame.type === 'message:new' && frame.message.body === 'private');
assert.equal(aliceDmFrame.message.id, bobDmFrame.message.id);
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(leakedToEve, false);
eveWs.off('message', leakListener);

const online = await api('/presence', { token: alice.token });
for (const user of [alice.user, bob.user, eve.user]) {
  assert.equal(online.body.find((item) => item.userId === user.id).status, 'online');
}

aliceWs.close();
bobWs.close();
eveWs.close();
await new Promise((resolve) => setTimeout(resolve, 150));
const offline = await api('/presence', { token: alice.token });
for (const user of [alice.user, bob.user, eve.user]) {
  assert.equal(offline.body.find((item) => item.userId === user.id).status, 'offline');
}

console.log('End-to-end REST and WebSocket contract smoke test passed.');
