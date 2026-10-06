const { TraeCleaner } = require('../trae-cleaner');
const { wrap } = require('./utils');

function runCleanerWithLogs(context, edition) {
  const cleaner = context.getActiveCleaner();
  if (cleaner) throw new Error('清理正在进行中');

  return new Promise((resolve, reject) => {
    const activeCleaner = new TraeCleaner((msg) => {
      const mainWindow = context.getMainWindow();
      mainWindow?.webContents.send('clean:log', msg);
    }, edition);
    context.setActiveCleaner(activeCleaner);

    activeCleaner
      .run()
      .then((result) => {
        context.setActiveCleaner(null);
        context.notifyTraeAccountChanged();
        resolve(result);
      })
      .catch((err) => {
        context.setActiveCleaner(null);
        reject(err);
      });
  });
}

function registerCleanIpc({ ipcMain, context }) {
  ipcMain.handle('clean:scan', wrap(async () => {
    const cleaner = new TraeCleaner(() => {});
    return cleaner.scan();
  }));

  ipcMain.handle('clean:start', async () => {
    if (context.getActiveCleaner()) return { ok: false, error: '清理正在进行中' };
    try {
      const data = await runCleanerWithLogs(context);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('clean:cancel', () => {
    const activeCleaner = context.getActiveCleaner();
    if (activeCleaner) {
      activeCleaner.cancel();
      return { ok: true };
    }
    return { ok: false };
  });
}

module.exports = { registerCleanIpc, runCleanerWithLogs };
