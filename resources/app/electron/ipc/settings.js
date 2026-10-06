const fs = require('fs');
const { dialog } = require('electron');
const accountStore = require('../account-store');
const { scanTraePath } = require('../trae-switcher');
const { getPlatformConfig } = require('../platform-config');
const mainI18n = require('../i18n');
const { wrap } = require('./utils');

function registerSettingsIpc({ ipcMain, context }) {
  const { getMainWindow, notifyTraeAccountChanged, setupAutoBackupTimer } = context;

  ipcMain.handle('settings:get-trae-path', wrap(() => accountStore.getTraePath()));
  ipcMain.handle('settings:set-trae-path', wrap(({ traePath }) => {
    if (!fs.existsSync(traePath)) throw new Error('路径不存在');
    accountStore.setTraePath(traePath);
    return traePath;
  }));
  ipcMain.handle('settings:scan-trae-path', wrap(() => scanTraePath()));
  ipcMain.handle('settings:pick-trae-path', wrap(async () => {
    const mainWindow = getMainWindow();
    const config = getPlatformConfig();
    if (!config) throw new Error('当前平台不支持');

    const filters =
      process.platform === 'darwin'
        ? [{ name: 'Application', extensions: ['app'] }]
        : [{ name: 'Executable', extensions: ['exe'] }];

    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Trae IDE',
      properties: process.platform === 'darwin' ? ['openDirectory'] : ['openFile'],
      filters,
    });

    if (result.canceled || !result.filePaths[0]) return null;
    accountStore.setTraePath(result.filePaths[0]);
    return result.filePaths[0];
  }));

  ipcMain.handle('settings:pick-backup-dir', wrap(async () => {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择自动备份目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  }));

  ipcMain.handle('settings:run-backup-now', wrap(() => accountStore.runAutoBackup()));
  ipcMain.handle('settings:last-backup', wrap(() => accountStore.getLastAutoBackupAt()));

  ipcMain.handle('settings:platform', wrap(() => {
    const config = getPlatformConfig();
    return config ? { platform: config.platform, label: config.label } : null;
  }));

  ipcMain.handle('settings:get-app', wrap(() => accountStore.getSettings()));
  ipcMain.handle('settings:save-app', wrap((settings) => {
    const next = accountStore.saveSettings(settings || {});
    if (next.language) mainI18n.setLocale(next.language);
    setupAutoBackupTimer();
    return next;
  }));
}

module.exports = { registerSettingsIpc };
