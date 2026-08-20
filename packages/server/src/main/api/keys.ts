import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type JWK,
} from 'jose';

export const JWT_ALG = 'ES256' as const;

export interface SigningKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** RFC 7638 thumbprint of the public JWK, published in the JWT header. */
  kid: string;
  publicJwk: JWK;
}

const PRIVATE_PEM = 'jwt-es256-private.pem';
const PUBLIC_PEM = 'jwt-es256-public.pem';

async function fromPem(privatePem: string, publicPem: string): Promise<SigningKeys> {
  const privateKey = await importPKCS8(privatePem, JWT_ALG, { extractable: true });
  const publicKey = await importSPKI(publicPem, JWT_ALG, { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return {
    privateKey,
    publicKey,
    kid,
    publicJwk: { ...jwk, kid, alg: JWT_ALG, use: 'sig' },
  };
}

/**
 * Load the ECDSA P-256 signing pair from `directory`, generating and persisting
 * one on first run. The private key never leaves the server machine; clients
 * only ever need the public half, which is served at /.well-known/jwks.json.
 */
export async function loadOrCreateKeys(directory: string): Promise<SigningKeys> {
  const privatePath = join(directory, PRIVATE_PEM);
  const publicPath = join(directory, PUBLIC_PEM);

  try {
    const [privatePem, publicPem] = await Promise.all([
      readFile(privatePath, 'utf8'),
      readFile(publicPath, 'utf8'),
    ]);
    return await fromPem(privatePem, publicPem);
  } catch {
    // Fall through to generation: missing, unreadable, or corrupt on-disk keys
    // are all recoverable by minting a fresh pair (which invalidates old tokens).
  }

  const { privateKey, publicKey } = await generateKeyPair(JWT_ALG, { extractable: true });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);

  await mkdir(dirname(privatePath), { recursive: true });
  // 0o600: the private key is the root of trust for every issued token.
  await writeFile(privatePath, privatePem, { mode: 0o600 });
  await writeFile(publicPath, publicPem, { mode: 0o644 });

  return fromPem(privatePem, publicPem);
}

/** Discard the current pair so the next load mints a new one, revoking all tokens. */
export async function rotateKeys(directory: string): Promise<SigningKeys> {
  const { privateKey, publicKey } = await generateKeyPair(JWT_ALG, { extractable: true });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, PRIVATE_PEM), privatePem, { mode: 0o600 });
  await writeFile(join(directory, PUBLIC_PEM), publicPem, { mode: 0o644 });
  return fromPem(privatePem, publicPem);
}
