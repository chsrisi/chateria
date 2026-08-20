import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import type { PublicUser } from '@chateria/protocol';

export interface StoredSession {
  token: string;
  user: PublicUser;
  serverUrl: string;
}

interface VaultFile {
  serverUrl: string;
  /** OS-encrypted StoredSession, base64. Absent when signed out. */
  session?: string;
}

const DEFAULT_SERVER_URL = process.env.CHATERIA_SERVER_URL ?? 'http://127.0.0.1:3000';

/**
 * Holds the server address in plain JSON and the bearer token under the OS
 * keychain via safeStorage. The token never touches disk unencrypted: where
 * safeStorage is unavailable the session simply stays in memory for the
 * session and the user signs in again next launch.
 */
export class Vault {
  readonly #path: string;
  #file: VaultFile;
  #memorySession: StoredSession | null = null;

  constructor(directory: string) {
    this.#path = join(directory, 'client.json');
    this.#file = this.#read();
  }

  #read(): VaultFile {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as VaultFile;
      return { serverUrl: parsed.serverUrl || DEFAULT_SERVER_URL, session: parsed.session };
    } catch {
      return { serverUrl: DEFAULT_SERVER_URL };
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#file, null, 2), 'utf8');
    renameSync(temporary, this.#path);
  }

  get encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  getServerUrl(): string {
    return this.#file.serverUrl;
  }

  setServerUrl(url: string): string {
    this.#file.serverUrl = url;
    this.#write();
    return url;
  }

  getSession(): StoredSession | null {
    if (this.#memorySession) return this.#memorySession;
    if (!this.#file.session || !this.encryptionAvailable) return null;
    try {
      const plain = safeStorage.decryptString(Buffer.from(this.#file.session, 'base64'));
      return JSON.parse(plain) as StoredSession;
    } catch {
      // A key change or a different machine makes the blob undecryptable.
      delete this.#file.session;
      this.#write();
      return null;
    }
  }

  setSession(session: StoredSession): void {
    this.#memorySession = session;
    this.#file.serverUrl = session.serverUrl;
    if (this.encryptionAvailable) {
      this.#file.session = safeStorage
        .encryptString(JSON.stringify(session))
        .toString('base64');
    }
    this.#write();
  }

  clearSession(): void {
    this.#memorySession = null;
    delete this.#file.session;
    this.#write();
  }

  /** Remove the file entirely, e.g. after a corrupt-state reset. */
  destroy(): void {
    this.#memorySession = null;
    this.#file = { serverUrl: DEFAULT_SERVER_URL };
    rmSync(this.#path, { force: true });
  }
}
