const { registerAccountsIpc } = require('./accounts');
const { registerSettingsIpc } = require('./settings');
const { registerCleanIpc } = require('./clean');
const { registerCheckinIpc } = require('./checkin');
const { registerMigrateIpc } = require('./migrate');
const { registerRegisterIpc } = require('./register');
const { registerWorkbuddyIpc } = require('./workbuddy');
const { registerAppIpc } = require('./app');
const { registerGatewayIpc } = require('./gateway');

function registerIpcHandlers({ ipcMain, app, context }) {
  registerAppIpc({ ipcMain, app });
  registerAccountsIpc({ ipcMain, context });
  registerSettingsIpc({ ipcMain, context });
  registerCleanIpc({ ipcMain, context });
  registerCheckinIpc({ ipcMain, context });
  registerMigrateIpc({ ipcMain, context });
  registerRegisterIpc({ ipcMain, context });
  registerWorkbuddyIpc({ ipcMain, context });
  registerGatewayIpc({ ipcMain, context });
}

module.exports = { registerIpcHandlers };
