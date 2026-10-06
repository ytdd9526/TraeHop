const { app, BrowserWindow, ipcMain, webcrypto } = require('electron');
const { APP_NAME, APP_SLUG, getIconPath } = require('./app-brand');
const mainI18n = require('./i18n');
const path = require('path');
const fs = require('fs');
const accountStore = require('./account-store');
const { getStoragePath } = require('./trae-reader');
const { setupTray, destroyTray } = require('./tray');
const { registerIpcHandlers } = require('./ipc');
const { switchAccount } = require('./ipc/accounts');
const context = require('./ipc/context');
const { gateway } = require('./gateway');

global.crypto = webcrypto;

app.setName(APP_SLUG);

function showMainWindow() {
  const mainWindow = context.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createWindow() {
  const iconPath = getIconPath();
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: APP_NAME,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '../src/index.html'));
  mainWindow.webContents.on('did-finish-load', setupStorageWatcher);
  mainWindow.on('focus', () => context.notifyTraeAccountChanged());

  context.setMainWindow(mainWindow);

  let trayApi = context.getTrayApi();
  if (!trayApi) {
    trayApi = setupTray({
      getAccounts: () => accountStore.listAccounts(),
      onSwitch: async (id) => {
        try {
          await switchAccount(id);
          context.notifyTraeAccountChanged();
        } catch (err) {
          context.sendNotification('切换失败', err.message);
        }
      },
      onShowWindow: showMainWindow,
    });
    context.setTrayApi(trayApi);
  }
}

function setupStorageWatcher() {
  const watcher = context.getStorageWatcher();
  try {
    if (watcher.size) {
      for (const p of watcher) fs.unwatchFile(p);
      watcher.clear();
    }

    for (const edition of ['cn', 'intl']) {
      const storagePath = getStoragePath(edition);
      if (!fs.existsSync(storagePath)) continue;
      fs.watchFile(storagePath, { interval: 2000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) context.notifyTraeAccountChanged();
      });
      watcher.add(storagePath);
    }
  } catch {
    /* ignore */
  }
}

function setupAutoBackupTimer() {
  const existing = context.getAutoBackupTimer();
  if (existing) {
    clearInterval(existing);
    context.setAutoBackupTimer(null);
  }

  const settings = accountStore.getSettings();
  if (!settings.autoBackupEnabled) return;

  const ms = settings.autoBackupIntervalHours * 3600000;
  const timer = setInterval(() => {
    try {
      accountStore.runAutoBackup();
    } catch {
      /* ignore */
    }
  }, ms);
  context.setAutoBackupTimer(timer);
}

context.setAutoBackupTimerHandler(setupAutoBackupTimer);

app.whenReady().then(() => {
  const settings = accountStore.getSettings();
  mainI18n.setLocale(settings.language || mainI18n.detectLocale());
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(getIconPath());
  }
  registerIpcHandlers({ ipcMain, app, context });
  createWindow();
  setupAutoBackupTimer();
  gateway.setSchedulerContext({
    isCheckinRunning: context.isCheckinRunning,
    setCheckinRunning: context.setCheckinRunning,
  });
  if (gateway.config.autoStart) {
    gateway
      .start()
      .then((st) => {
        if (!st.running) console.error('[gateway] 启动失败');
      })
      .catch((err) => console.error('[gateway] 启动失败:', err.message));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showMainWindow();
});

app.on('before-quit', () => {
  destroyTray();
  gateway.stop();
  const watcher = context.getStorageWatcher();
  for (const p of watcher) fs.unwatchFile(p);
  watcher.clear();
});
