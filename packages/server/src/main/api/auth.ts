import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import type { PublicUser } from '@chateria/protocol';
import { JWT_ALG, type SigningKeys } from './keys.ts';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const ISSUER = 'chateria-server';
const AUDIENCE = 'chateria-client';

/* ------------------------------------------------------------------ *
 * Passwords
 * ------------------------------------------------------------------ */

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/** Encoded as `scrypt$<salt-b64>$<hash-b64>` so the format can evolve later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  // Lengths match by construction, but timingSafeEqual throws if they ever differ.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

export async function createToken(
  user: PublicUser,
  keys: SigningKeys,
  ttl: string,
): Promise<string> {
  return new SignJWT({ username: user.username })
    .setProtectedHeader({ alg: JWT_ALG, kid: keys.kid, typ: 'JWT' })
    .setSubject(String(user.id))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(keys.privateKey);
}

/**
 * Verify an ES256 token. `algorithms` is pinned so a token claiming `none`,
 * `HS256`, or any other algorithm is rejected before the signature is checked.
 */
export async function verifyToken(token: string, keys: SigningKeys): Promise<PublicUser> {
  const { payload } = await jwtVerify(token, keys.publicKey, {
    algorithms: [JWT_ALG],
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  const id = Number(payload.sub);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid token subject');
  if (typeof payload.username !== 'string' || !payload.username) {
    throw new Error('Invalid token username');
  }
  return { id, username: payload.username };
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1] ?? null;
}
