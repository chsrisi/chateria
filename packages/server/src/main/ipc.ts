import type { ApiStats } from './api/server.ts';
import type { Settings } from './settings.ts';

/** Shape of the bridge exposed to the renderer as `window.chateria`. */
export interface ServerBridge {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  start(): Promise<ApiStats>;
  stop(): Promise<ApiStats>;
  restart(): Promise<ApiStats>;
  rotateKey(): Promise<string>;
  getStats(): Promise<ApiStats>;
  getLog(): Promise<LogEntry[]>;
  openKeyFolder(): Promise<void>;
  onStats(handler: (stats: ApiStats) => void): () => void;
  onLog(handler: (entry: LogEntry) => void): () => void;
}

export interface LogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const CHANNELS = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  start: 'server:start',
  stop: 'server:stop',
  restart: 'server:restart',
  rotateKey: 'server:rotate-key',
  getStats: 'server:stats',
  getLog: 'server:log-history',
  openKeyFolder: 'server:open-key-folder',
  pushStats: 'server:stats-changed',
  pushLog: 'server:log',
} as const;
