const { runRegisterBatch, cancelRegister } = require('../trae-register');
const { wrap } = require('./utils');

function registerRegisterIpc({ ipcMain, context }) {
  ipcMain.handle('register:run', wrap(async (opts = {}) => {
    if (context.isRegisterRunning()) throw new Error('注册任务正在进行中');
    context.setRegisterRunning(true);
    try {
      return await runRegisterBatch({
        total: Math.max(1, Math.min(20, Number(opts.total) || 1)),
        concurrency: Math.max(1, Math.min(3, Number(opts.concurrency) || 1)),
        claimGift: !!opts.claimGift,
        proxies: Array.isArray(opts.proxies) ? opts.proxies : [],
        pace: opts.pace === 'fast' ? 'fast' : 'steady',
        edition: 'intl',
      }, (msg) => {
        const mainWindow = context.getMainWindow();
        mainWindow?.webContents.send('register:log', msg);
      });
    } finally {
      context.setRegisterRunning(false);
    }
  }));

  ipcMain.handle('register:cancel', wrap(() => {
    cancelRegister();
    return { ok: true };
  }));
}

module.exports = { registerRegisterIpc };
