import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type ClientBridge } from '../main/ipc.ts';
import type { StoredSession } from '../main/vault.ts';

const bridge: ClientBridge = {
  getServerUrl: () => ipcRenderer.invoke(CHANNELS.getServerUrl) as Promise<string>,
  setServerUrl: (url) => ipcRenderer.invoke(CHANNELS.setServerUrl, url) as Promise<string>,
  getSession: () => ipcRenderer.invoke(CHANNELS.getSession) as Promise<StoredSession | null>,
  saveSession: (session) => ipcRenderer.invoke(CHANNELS.saveSession, session) as Promise<void>,
  clearSession: () => ipcRenderer.invoke(CHANNELS.clearSession) as Promise<void>,
  encryptionAvailable: () =>
    ipcRenderer.invoke(CHANNELS.encryptionAvailable) as Promise<boolean>,
  setBadge: (count) => ipcRenderer.invoke(CHANNELS.setBadge, count) as Promise<void>,
  notify: (title, body) => ipcRenderer.invoke(CHANNELS.notify, title, body) as Promise<void>,
};

contextBridge.exposeInMainWorld('chateria', bridge);
