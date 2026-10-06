const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const accountStore = require('../account-store');
const { migrateSessionsToAccount } = require('../session-migrator');
const { wrap } = require('./utils');

function registerMigrateIpc({ ipcMain, context }) {
  ipcMain.handle('migrate:sessions', wrap(async ({ id } = {}) => {
    if (!id) throw new Error('缺少目标账号');
    if (context.isMigrationRunning()) throw new Error('迁移正在进行中');
    const account = accountStore.getAccount(id);
    if (account?.platform === 'workbuddy') {
      throw new Error('WorkBuddy 账号不支持会话迁移');
    }

    // 迁移日志落盘：迁移必然 killTrae，日志窗口随 IDE 一起没了，排查全靠这里
    let logFile = '';
    const onLog = (msg) => {
      try {
        if (!logFile) return;
        fs.appendFileSync(logFile, `[${new Date().toTimeString().slice(0, 8)}] ${msg}\n`);
      } catch { /* 落盘失败不影响迁移 */ }
    };
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      logFile = path.join(logDir, `migrate-${stamp}.log`);
      onLog(`目标账号 ${id}（${account?.name || account?.email || '未知'}），日志落盘 ${logFile}`);
    } catch { /* */ }

    context.setMigrationRunning(true);
    try {
      const result = await migrateSessionsToAccount(id, (msg) => {
        onLog(msg);
        const mainWindow = context.getMainWindow();
        mainWindow?.webContents.send('migrate:log', msg);
      });
      accountStore.setCurrentAccount(id);
      context.notifyTraeAccountChanged();
      onLog(`✅ 迁移完成：${JSON.stringify(result)}`);
      return result;
    } catch (err) {
      onLog(`❌ 迁移失败：${err.message}\n${err.stack || ''}`);
      throw err;
    } finally {
      context.setMigrationRunning(false);
    }
  }));
}

module.exports = { registerMigrateIpc };
