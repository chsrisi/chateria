import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { createApiRuntime, type ApiStats, type LogLevel } from './api/server.ts';
import { CHANNELS, type LogEntry } from './ipc.ts';
import { SettingsStore } from './settings.ts';

const LOG_LIMIT = 500;
const STATS_INTERVAL_MS = 2000;

let window: BrowserWindow | null = null;
const log: LogEntry[] = [];

const userData = app.getPath('userData');
const settings = new SettingsStore(userData);
const keyDirectory = join(userData, 'keys');

function pushToRenderer(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function record(level: LogLevel, message: string): void {
  const entry: LogEntry = { at: new Date().toISOString(), level, message };
  log.push(entry);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  pushToRenderer(CHANNELS.pushLog, entry);
}

const runtime = createApiRuntime(keyDirectory, record);

function createWindow(): void {
  window = new BrowserWindow({
    width: 1_040,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    show: false,
    title: 'Chateria Server',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window?.show());

  // Anything that wants a new window is an external link; hand it to the OS
  // browser rather than opening an unrestricted Electron window.
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

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle(CHANNELS.getSettings, () => settings.get());

  ipcMain.handle(CHANNELS.saveSettings, (_event, patch: Record<string, unknown>) => {
    // The renderer is trusted-ish, but still take only known keys with the
    // right types rather than spreading whatever arrives over the bridge.
    const current = settings.get();
    return settings.update({
      databaseUrl:
        typeof patch.databaseUrl === 'string' ? patch.databaseUrl : current.databaseUrl,
      port:
        Number.isInteger(patch.port) && (patch.port as number) > 0 && (patch.port as number) < 65_536
          ? (patch.port as number)
          : current.port,
      maxMessageLength:
        Number.isInteger(patch.maxMessageLength) && (patch.maxMessageLength as number) > 0
          ? (patch.maxMessageLength as number)
          : current.maxMessageLength,
      tokenTtl: typeof patch.tokenTtl === 'string' ? patch.tokenTtl : current.tokenTtl,
      autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : current.autoStart,
    });
  });

  ipcMain.handle(CHANNELS.start, async () => announce(await runtime.start(settings.get())));
  ipcMain.handle(CHANNELS.stop, async () => announce(await runtime.stop()));
  ipcMain.handle(CHANNELS.restart, async () => {
    await runtime.stop();
    return announce(await runtime.start(settings.get()));
  });
  ipcMain.handle(CHANNELS.rotateKey, async () => {
    const kid = await runtime.rotate();
    announce(runtime.stats());
    return kid;
  });
  ipcMain.handle(CHANNELS.getStats, () => runtime.stats());
  ipcMain.handle(CHANNELS.getLog, () => log);
  ipcMain.handle(CHANNELS.openKeyFolder, () => shell.openPath(keyDirectory));
}

function announce(stats: ApiStats): ApiStats {
  pushToRenderer(CHANNELS.pushStats, stats);
  return stats;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

// A second copy would fight for the same TCP port and settings file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(async () => {
    registerIpc();
    createWindow();

    // Connected-socket counts change without any IPC call, so poll a light
    // snapshot rather than making every hub event cross the bridge.
    setInterval(() => pushToRenderer(CHANNELS.pushStats, runtime.stats()), STATS_INTERVAL_MS);

    if (settings.get().autoStart) {
      announce(await runtime.start(settings.get()));
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (runtime.stats().status === 'stopped') return;
    // Close sockets and the pool before the process goes away.
    event.preventDefault();
    void runtime.stop().finally(() => app.exit(0));
  });
}
