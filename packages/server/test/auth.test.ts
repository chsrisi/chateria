import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SignJWT, generateKeyPair } from 'jose';
import { createToken, hashPassword, verifyPassword, verifyToken } from '../src/main/api/auth.ts';
import { loadOrCreateKeys, rotateKeys } from '../src/main/api/keys.ts';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'chateria-keys-'));
}

test('scrypt hashes verify and reject wrong passwords', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  // Two hashes of the same password differ: the salt is random.
  assert.notEqual(stored, await hashPassword('correct horse battery staple'));
});

test('malformed password hashes are rejected, not thrown on', async () => {
  for (const bad of ['', 'nonsense', 'bcrypt$a$b', 'scrypt$only-one-part']) {
    assert.equal(await verifyPassword('x', bad), false);
  }
});

test('keys persist across loads and rotation replaces them', async () => {
  const directory = await scratch();
  try {
    const first = await loadOrCreateKeys(directory);
    const second = await loadOrCreateKeys(directory);
    assert.equal(first.kid, second.kid, 'a second load must reuse the stored key');
    assert.equal(first.publicJwk.crv, 'P-256');
    assert.equal(first.publicJwk.alg, 'ES256');
    assert.equal(first.publicJwk.d, undefined, 'the published JWK must not carry the private half');

    const rotated = await rotateKeys(directory);
    assert.notEqual(rotated.kid, first.kid);

    const pem = await readFile(join(directory, 'jwt-es256-private.pem'), 'utf8');
    assert.match(pem, /BEGIN PRIVATE KEY/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ES256 tokens round-trip and carry the key id', async () => {
  const directory = await scratch();
  try {
    const keys = await loadOrCreateKeys(directory);
    const token = await createToken({ id: 7, username: 'Lin' }, keys, '1m');

    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as {
      alg: string;
      kid: string;
    };
    assert.equal(header.alg, 'ES256');
    assert.equal(header.kid, keys.kid);

    assert.deepEqual(await verifyToken(token, keys), { id: 7, username: 'Lin' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verification rejects alg confusion, foreign keys, and expiry', async () => {
  const directory = await scratch();
  try {
    const keys = await loadOrCreateKeys(directory);

    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    )}.${Buffer.from(JSON.stringify({ sub: '7', username: 'Lin' })).toString('base64url')}.`;
    await assert.rejects(() => verifyToken(unsigned, keys), 'alg=none must be rejected');

    // A token signed with a *different* ES256 key must not verify.
    const stranger = await generateKeyPair('ES256', { extractable: true });
    const foreign = await new SignJWT({ username: 'Mallory' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('7')
      .setIssuer('chateria-server')
      .setAudience('chateria-client')
      .setExpirationTime('1m')
      .sign(stranger.privateKey);
    await assert.rejects(() => verifyToken(foreign, keys), 'a foreign key must be rejected');

    const expired = await new SignJWT({ username: 'Lin' })
      .setProtectedHeader({ alg: 'ES256', kid: keys.kid })
      .setSubject('7')
      .setIssuer('chateria-server')
      .setAudience('chateria-client')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keys.privateKey);
    await assert.rejects(() => verifyToken(expired, keys), 'an expired token must be rejected');

    // Correctly signed, but issued for something other than this service.
    const wrongAudience = await new SignJWT({ username: 'Lin' })
      .setProtectedHeader({ alg: 'ES256', kid: keys.kid })
      .setSubject('7')
      .setIssuer('chateria-server')
      .setAudience('someone-else')
      .setExpirationTime('1m')
      .sign(keys.privateKey);
    await assert.rejects(() => verifyToken(wrongAudience, keys));

    // A rotated key must invalidate tokens minted under the old one.
    const good = await createToken({ id: 7, username: 'Lin' }, keys, '1m');
    const rotated = await rotateKeys(directory);
    await assert.rejects(() => verifyToken(good, rotated), 'rotation must revoke old tokens');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('token subjects must be positive integers', async () => {
  const directory = await scratch();
  try {
    const keys = await loadOrCreateKeys(directory);
    for (const subject of ['0', '-3', 'abc', '1.5']) {
      const token = await new SignJWT({ username: 'Lin' })
        .setProtectedHeader({ alg: 'ES256', kid: keys.kid })
        .setSubject(subject)
        .setIssuer('chateria-server')
        .setAudience('chateria-client')
        .setExpirationTime('1m')
        .sign(keys.privateKey);
      await assert.rejects(() => verifyToken(token, keys), `subject ${subject} must be rejected`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
