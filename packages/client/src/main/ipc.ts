import type { StoredSession } from './vault.ts';

export interface ClientBridge {
  getServerUrl(): Promise<string>;
  setServerUrl(url: string): Promise<string>;
  getSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession): Promise<void>;
  clearSession(): Promise<void>;
  /** False on platforms with no OS keychain: the session will not persist. */
  encryptionAvailable(): Promise<boolean>;
  setBadge(count: number): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}

export const CHANNELS = {
  getServerUrl: 'client:get-server-url',
  setServerUrl: 'client:set-server-url',
  getSession: 'client:get-session',
  saveSession: 'client:save-session',
  clearSession: 'client:clear-session',
  encryptionAvailable: 'client:encryption-available',
  setBadge: 'client:set-badge',
  notify: 'client:notify',
} as const;
