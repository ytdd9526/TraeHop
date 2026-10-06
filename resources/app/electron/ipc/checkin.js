const { runCheckinAll, getCheckinState, checkinOne } = require('../checkin');
const { wrap } = require('./utils');

function registerCheckinIpc({ ipcMain, context }) {
  ipcMain.handle('checkin:state', wrap(() => getCheckinState()));

  ipcMain.handle('checkin:run', wrap(async () => {
    if (context.isCheckinRunning()) throw new Error('签到正在进行中');
    context.setCheckinRunning(true);
    try {
      return await runCheckinAll((msg) => {
        const mainWindow = context.getMainWindow();
        mainWindow?.webContents.send('checkin:log', msg);
      });
    } finally {
      context.setCheckinRunning(false);
    }
  }));

  ipcMain.handle('checkin:one', wrap(async ({ id }) => {
    if (!id) throw new Error('缺少账号 ID');
    if (context.isCheckinRunning()) throw new Error('签到正在进行中');
    context.setCheckinRunning(true);
    try {
      const result = await checkinOne(id, (msg) => {
        const mainWindow = context.getMainWindow();
        mainWindow?.webContents.send('checkin:log', msg);
      });
      return result;
    } finally {
      context.setCheckinRunning(false);
    }
  }));
}

module.exports = { registerCheckinIpc };
