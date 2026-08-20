import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type LogEntry, type ServerBridge } from '../main/ipc.ts';
import type { ApiStats } from '../main/api/server.ts';
import type { Settings } from '../main/settings.ts';

/**
 * The only surface the renderer gets. No ipcRenderer, no Node, no dynamic
 * channel names -- each method maps to one fixed channel.
 */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: ServerBridge = {
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings) as Promise<Settings>,
  saveSettings: (patch) => ipcRenderer.invoke(CHANNELS.saveSettings, patch) as Promise<Settings>,
  start: () => ipcRenderer.invoke(CHANNELS.start) as Promise<ApiStats>,
  stop: () => ipcRenderer.invoke(CHANNELS.stop) as Promise<ApiStats>,
  restart: () => ipcRenderer.invoke(CHANNELS.restart) as Promise<ApiStats>,
  rotateKey: () => ipcRenderer.invoke(CHANNELS.rotateKey) as Promise<string>,
  getStats: () => ipcRenderer.invoke(CHANNELS.getStats) as Promise<ApiStats>,
  getLog: () => ipcRenderer.invoke(CHANNELS.getLog) as Promise<LogEntry[]>,
  openKeyFolder: () => ipcRenderer.invoke(CHANNELS.openKeyFolder) as Promise<void>,
  onStats: (handler) => subscribe<ApiStats>(CHANNELS.pushStats, handler),
  onLog: (handler) => subscribe<LogEntry>(CHANNELS.pushLog, handler),
};

contextBridge.exposeInMainWorld('chateria', bridge);
