/**
 * End-to-end contract check against a running API.
 *
 * Boots the real server (Express + WebSocket + Postgres) in-process, so it
 * needs only a reachable database -- not the Electron shell. Point it at a
 * different database with CHATERIA_DATABASE_URL.
 *
 *   npm run test:e2e -w @chateria/server
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { AuthResult, ServerEvent } from '@chateria/protocol';
import { DEFAULT_CONFIG } from '../src/main/api/config.ts';
import { createApiRuntime } from '../src/main/api/server.ts';

const PORT = Number(process.env.TEST_API_PORT ?? 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const quiet = process.env.TEST_VERBOSE !== '1';

const keyDirectory = await mkdtemp(join(tmpdir(), 'chateria-e2e-'));
const runtime = createApiRuntime(keyDirectory, (level, message) => {
  if (!quiet || level === 'error') console.log(`  [${level}] ${message}`);
});

const started = await runtime.start({
  ...DEFAULT_CONFIG,
  port: PORT,
  tokenTtl: '5m',
});

if (started.status !== 'running') {
  console.error(`\n✗ Could not start the API: ${started.error ?? 'unknown error'}`);
  console.error('  Is PostgreSQL up? Try: npm run db:up\n');
  await rm(keyDirectory, { recursive: true, force: true });
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

async function api<T>(
  path: string,
  { token, method = 'GET', body }: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body: payload as T };
}

interface Socket extends WebSocket {
  waitFor(predicate: (event: ServerEvent) => boolean, label?: string): Promise<ServerEvent>;
  seen: ServerEvent[];
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`,
    ) as Socket;
    const waiters: {
      predicate: (event: ServerEvent) => boolean;
      resolve: (event: ServerEvent) => void;
      timer: NodeJS.Timeout;
    }[] = [];
    socket.seen = [];

    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      const index = waiters.findIndex((waiter) => waiter.predicate(event));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(event);
      } else {
        socket.seen.push(event);
      }
    });

    socket.once('error', reject);
    socket.once('open', () => {
      socket.waitFor = (predicate, label = 'event') => {
        const existing = socket.seen.findIndex(predicate);
        if (existing >= 0) return Promise.resolve(socket.seen.splice(existing, 1)[0]!);
        return new Promise((done, fail) => {
          const waiter = {
            predicate,
            resolve: done,
            timer: setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              fail(new Error(`Timed out waiting for ${label}`));
            }, 4000),
          };
          waiters.push(waiter);
        });
      };
      resolve(socket);
    });
  });
}

const is = <T extends ServerEvent['type']>(type: T) => (event: ServerEvent) =>
  event.type === type;

let checks = 0;
async function step(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
const register = async (name: string): Promise<AuthResult> => {
  const result = await api<AuthResult>('/auth/register', {
    method: 'POST',
    body: { username: `${name}-${suffix}`, password: 'correct horse battery staple' },
  });
  assert.equal(result.status, 201, `register ${name}`);
  return result.body;
};

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

console.log(`\nChateria end-to-end contract (${started.databaseVersion})\n`);

const sockets: Socket[] = [];
let failure: unknown = null;

try {
  const alice = await register('alice');
  const bob = await register('bob');
  const eve = await register('eve');

  await step('ES256 metadata is published and tokens identify their key', async () => {
    const info = await (await fetch(`${BASE}/api/info`)).json();
    assert.equal(info.algorithm, 'ES256');

    const jwks = await (await fetch(`${BASE}/.well-known/jwks.json`)).json();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].crv, 'P-256');
    assert.equal(jwks.keys[0].d, undefined, 'JWKS must never expose the private key');

    const header = JSON.parse(
      Buffer.from(alice.token.split('.')[0]!, 'base64url').toString(),
    );
    assert.equal(header.alg, 'ES256');
    assert.equal(header.kid, jwks.keys[0].kid);
  });

  await step('authentication gates the API', async () => {
    assert.deepEqual((await api('/me', { token: alice.token })).body, alice.user);
    assert.equal((await api('/me')).status, 401);
    assert.equal((await api('/me', { token: `${alice.token}tampered` })).status, 401);
  });

  await step('an invalid websocket token closes with 4401', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=not-a-jwt`);
    const code = await new Promise<number>((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', () => {});
      setTimeout(() => reject(new Error('socket was not closed')), 4000);
    });
    assert.equal(code, 4401);
  });

  const aliceWs = await connect(alice.token);
  const bobWs = await connect(bob.token);
  const eveWs = await connect(eve.token);
  sockets.push(aliceWs, bobWs, eveWs);

  await step('each connection is greeted with welcome', async () => {
    for (const [socket, account] of [
      [aliceWs, alice],
      [bobWs, bob],
    ] as const) {
      const event = await socket.waitFor(is('welcome'), 'welcome');
      assert.equal(event.type, 'welcome');
      if (event.type === 'welcome') assert.deepEqual(event.user, account.user);
    }
  });

  /* ---- broadcast: room creation ---- */

  let roomId = 0;
  await step('room:created reaches every connected client', async () => {
    const bobSees = bobWs.waitFor(is('room:created'), 'room:created');
    const eveSees = eveWs.waitFor(is('room:created'), 'room:created');

    const created = await api<{ id: number }>('/rooms', {
      token: alice.token,
      method: 'POST',
      body: { name: `room-${suffix}` },
    });
    assert.equal(created.status, 201);
    roomId = created.body.id;

    for (const event of await Promise.all([bobSees, eveSees])) {
      assert.equal(event.type, 'room:created');
      if (event.type === 'room:created') {
        assert.equal(event.room.id, roomId);
        assert.equal(event.room.memberCount, 1, 'the creator is joined automatically');
        assert.deepEqual(event.createdBy, alice.user);
      }
    }
  });

  /* ---- broadcast: membership ---- */

  await step('room:member_joined carries the new member count', async () => {
    const aliceSees = aliceWs.waitFor(is('room:member_joined'), 'room:member_joined');
    assert.equal(
      (await api(`/rooms/${roomId}/join`, { token: bob.token, method: 'POST' })).status,
      204,
    );

    const event = await aliceSees;
    assert.equal(event.type, 'room:member_joined');
    if (event.type === 'room:member_joined') {
      assert.equal(event.roomId, roomId);
      assert.deepEqual(event.user, bob.user);
      assert.equal(event.memberCount, 2);
    }
  });

  await step('a repeat join is idempotent and does NOT re-broadcast', async () => {
    aliceWs.seen.length = 0;
    assert.equal(
      (await api(`/rooms/${roomId}/join`, { token: bob.token, method: 'POST' })).status,
      204,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      aliceWs.seen.filter((event) => event.type === 'room:member_joined').length,
      0,
      'joining twice must not emit a second membership event',
    );

    const rooms = await api<{ id: number; memberCount: number }[]>('/rooms', {
      token: alice.token,
    });
    assert.equal(rooms.body.find((room) => room.id === roomId)?.memberCount, 2);
  });

  /* ---- messaging ---- */

  aliceWs.send(JSON.stringify({ type: 'room:subscribe', roomId }));
  bobWs.send(JSON.stringify({ type: 'room:subscribe', roomId }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  await step('malformed frames are refused without dropping the socket', async () => {
    eveWs.send('{not json');
    assert.equal((await eveWs.waitFor(is('error'), 'error')).type, 'error');
    eveWs.send(JSON.stringify({ type: 'room:subscribe', roomId: -1 }));
    assert.equal((await eveWs.waitFor(is('error'), 'error')).type, 'error');
    eveWs.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await eveWs.waitFor(is('pong'), 'pong')).type, 'pong');
  });

  await step('the server owns author and timestamp, and echoes the nonce', async () => {
    const before = Date.now();
    const bobSees = bobWs.waitFor(
      (event) => event.type === 'message:new' && event.message.roomId === roomId,
      'message:new',
    );

    // Claim to be Eve, with a backdated timestamp. Both must be ignored.
    aliceWs.send(
      JSON.stringify({
        type: 'message:send',
        roomId,
        body: '  <img src=x onerror=alert(1)>  ',
        authorId: eve.user.id,
        createdAt: '2000-01-01T00:00:00.000Z',
        clientNonce: 'nonce-1',
      }),
    );

    const mine = await aliceWs.waitFor(
      (event) => event.type === 'message:new' && event.clientNonce === 'nonce-1',
      'own message:new',
    );
    const theirs = await bobSees;
    assert.equal(mine.type, 'message:new');
    assert.equal(theirs.type, 'message:new');
    if (mine.type !== 'message:new' || theirs.type !== 'message:new') return;

    assert.equal(mine.message.id, theirs.message.id);
    assert.equal(mine.message.authorId, alice.user.id, 'author comes from the token');
    assert.equal(mine.message.body, '<img src=x onerror=alert(1)>', 'body is trimmed, not escaped');
    assert.ok(Date.parse(mine.message.createdAt) >= before, 'timestamp comes from the server');
    assert.equal(theirs.clientNonce, undefined, 'the nonce goes only to the sender');
  });

  await step('non-members cannot post to or read a room', async () => {
    eveWs.send(JSON.stringify({ type: 'message:send', roomId, body: 'let me in' }));
    const error = await eveWs.waitFor(is('error'), 'error');
    if (error.type === 'error') assert.match(error.error, /member/i);
    assert.equal((await api(`/rooms/${roomId}/messages`, { token: eve.token })).status, 403);
  });

  await step('history paginates oldest-to-newest with a stable cursor', async () => {
    for (const body of ['second', 'third']) {
      aliceWs.send(JSON.stringify({ type: 'message:send', roomId, body }));
      await aliceWs.waitFor(
        (event) => event.type === 'message:new' && event.message.body === body,
        body,
      );
    }

    const newest = await api<{ messages: { id: number }[]; nextCursor: number | null }>(
      `/rooms/${roomId}/messages?limit=2`,
      { token: alice.token },
    );
    assert.equal(newest.body.messages.length, 2);
    assert.ok(newest.body.messages[0]!.id < newest.body.messages[1]!.id, 'ascending order');
    assert.notEqual(newest.body.nextCursor, null);

    const older = await api<{ messages: { id: number }[] }>(
      `/rooms/${roomId}/messages?limit=2&before=${newest.body.nextCursor}`,
      { token: alice.token },
    );
    assert.equal(older.body.messages.length, 1);
    const ids = [...older.body.messages, ...newest.body.messages].map((m) => m.id);
    assert.equal(new Set(ids).size, 3, 'pages must not overlap');

    assert.equal(
      (await api(`/rooms/${roomId}/messages?before=nope`, { token: alice.token })).status,
      400,
    );
  });

  /* ---- broadcast: DMs ---- */

  let conversationId = 0;
  await step('dm:created reaches both participants and nobody else', async () => {
    const aliceSees = aliceWs.waitFor(is('dm:created'), 'dm:created for alice');
    const bobSees = bobWs.waitFor(is('dm:created'), 'dm:created for bob');
    eveWs.seen.length = 0;

    const created = await api<{ conversationId: number }>('/dms', {
      token: alice.token,
      method: 'POST',
      body: { userId: bob.user.id },
    });
    assert.equal(created.status, 201);
    conversationId = created.body.conversationId;

    const forAlice = await aliceSees;
    const forBob = await bobSees;
    // Each side is told about the *other* participant.
    if (forAlice.type === 'dm:created') {
      assert.equal(forAlice.conversation.otherUser.id, bob.user.id);
    }
    if (forBob.type === 'dm:created') {
      assert.equal(forBob.conversation.otherUser.id, alice.user.id);
    }
    assert.equal(
      eveWs.seen.filter((event) => event.type === 'dm:created').length,
      0,
      'a third party must not learn about the conversation',
    );
  });

  await step('creating an existing DM returns the same id without re-broadcasting', async () => {
    aliceWs.seen.length = 0;
    const again = await api<{ conversationId: number }>('/dms', {
      token: bob.token,
      method: 'POST',
      body: { userId: alice.user.id },
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.conversationId, conversationId, 'unordered pairs are unique');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(aliceWs.seen.filter((event) => event.type === 'dm:created').length, 0);

    assert.equal(
      (await api('/dms', { token: alice.token, method: 'POST', body: { userId: alice.user.id } }))
        .status,
      400,
      'a DM with yourself is refused',
    );
  });

  await step('DM traffic never leaks to a third party', async () => {
    let leaked = false;
    const watch = (raw: Buffer): void => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      if (event.type === 'message:new' && event.message.conversationId === conversationId) {
        leaked = true;
      }
    };
    eveWs.on('message', watch);

    aliceWs.send(JSON.stringify({ type: 'message:send', conversationId, body: 'private' }));
    const mine = await aliceWs.waitFor(
      (event) => event.type === 'message:new' && event.message.body === 'private',
      'own dm',
    );
    const theirs = await bobWs.waitFor(
      (event) => event.type === 'message:new' && event.message.body === 'private',
      'bob dm',
    );
    if (mine.type === 'message:new' && theirs.type === 'message:new') {
      assert.equal(mine.message.id, theirs.message.id);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    eveWs.off('message', watch);
    assert.equal(leaked, false);
    assert.equal((await api(`/dms/${conversationId}/messages`, { token: eve.token })).status, 403);
  });

  /* ---- broadcast: leaving + presence ---- */

  await step('room:member_left fires once and decrements the count', async () => {
    const aliceSees = aliceWs.waitFor(is('room:member_left'), 'room:member_left');
    assert.equal(
      (await api(`/rooms/${roomId}/leave`, { token: bob.token, method: 'POST' })).status,
      204,
    );
    const event = await aliceSees;
    if (event.type === 'room:member_left') {
      assert.equal(event.userId, bob.user.id);
      assert.equal(event.memberCount, 1);
    }

    aliceWs.seen.length = 0;
    await api(`/rooms/${roomId}/leave`, { token: bob.token, method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(aliceWs.seen.filter((e) => e.type === 'room:member_left').length, 0);
  });

  await step('user:registered announces a new account to everyone', async () => {
    const aliceSees = aliceWs.waitFor(is('user:registered'), 'user:registered');
    const newcomer = await register('zoe');
    const event = await aliceSees;
    if (event.type === 'user:registered') assert.deepEqual(event.user, newcomer.user);
  });

  await step('presence reflects live sockets on both REST and the socket', async () => {
    const online = await api<{ userId: number; status: string }[]>('/presence', {
      token: alice.token,
    });
    for (const account of [alice, bob, eve]) {
      assert.equal(
        online.body.find((entry) => entry.userId === account.user.id)?.status,
        'online',
      );
    }

    const aliceSees = aliceWs.waitFor(
      (event) => event.type === 'presence:update' && event.userId === eve.user.id,
      'presence offline',
    );
    eveWs.close();
    const event = await aliceSees;
    if (event.type === 'presence:update') assert.equal(event.status, 'offline');

    const after = await api<{ userId: number; status: string }[]>('/presence', {
      token: alice.token,
    });
    assert.equal(
      after.body.find((entry) => entry.userId === eve.user.id)?.status,
      'offline',
    );
  });

  await step('rotating the signing key revokes existing tokens', async () => {
    await runtime.rotate();
    assert.equal(
      (await api('/me', { token: alice.token })).status,
      401,
      'a token signed by the retired key must stop working',
    );
    const back = await api<AuthResult>('/auth/login', {
      method: 'POST',
      body: { username: alice.user.username, password: 'correct horse battery staple' },
    });
    assert.equal(back.status, 200);
    assert.equal((await api('/me', { token: back.body.token })).status, 200);
  });
} catch (error) {
  failure = error;
}

for (const socket of sockets) socket.close();
await runtime.stop();
await rm(keyDirectory, { recursive: true, force: true });

if (failure) {
  console.error(`\n✗ FAILED after ${checks} checks\n`);
  console.error(failure);
  process.exit(1);
}

console.log(`\n✓ All ${checks} end-to-end checks passed.\n`);
process.exit(0);
