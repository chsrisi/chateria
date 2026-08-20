import { join } from 'node:path';
import { BrowserWindow, Notification, app, ipcMain, shell } from 'electron';
import { CHANNELS } from './ipc.ts';
import { Vault, type StoredSession } from './vault.ts';

let window: BrowserWindow | null = null;
let vault: Vault;

function createWindow(): void {
  window = new BrowserWindow({
    width: 1_120,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Chateria',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0c1020',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window?.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.getServerUrl, () => vault.getServerUrl());

  ipcMain.handle(CHANNELS.setServerUrl, (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('Server URL must be a string');
    // Reject anything that is not an http(s) origin before it reaches fetch().
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Server URL must use http or https');
    }
    return vault.setServerUrl(parsed.origin);
  });

  ipcMain.handle(CHANNELS.getSession, () => vault.getSession());

  ipcMain.handle(CHANNELS.saveSession, (_event, session: StoredSession) => {
    if (typeof session?.token !== 'string' || typeof session?.user?.id !== 'number') {
      throw new Error('Malformed session');
    }
    vault.setSession(session);
  });

  ipcMain.handle(CHANNELS.clearSession, () => vault.clearSession());
  ipcMain.handle(CHANNELS.encryptionAvailable, () => vault.encryptionAvailable);

  ipcMain.handle(CHANNELS.setBadge, (_event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isFinite(count)) return;
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    } else {
      app.setBadgeCount(Math.max(0, Math.trunc(count)));
    }
  });

  ipcMain.handle(CHANNELS.notify, (_event, title: unknown, body: unknown) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
    // Only notify when the user is not already looking at the window.
    if (window?.isFocused()) return;
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    vault = new Vault(app.getPath('userData'));
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
