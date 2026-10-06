const { gateway } = require('../gateway');
const { wrap } = require('./utils');

function registerGatewayIpc({ ipcMain, context }) {
  gateway.setSchedulerContext({
    isCheckinRunning: context.isCheckinRunning,
    setCheckinRunning: context.setCheckinRunning,
  });

  ipcMain.handle('gateway:config', wrap(() => ({ ...gateway.config })));
  ipcMain.handle('gateway:save-config', wrap(({ partial }) => gateway.applyConfig(partial || {})));
  ipcMain.handle('gateway:reset-key', wrap(() => gateway.resetApiKey()));
  ipcMain.handle('gateway:status', wrap(() => gateway.status()));
  ipcMain.handle('gateway:start', wrap(() => gateway.start()));
  ipcMain.handle('gateway:stop', wrap(() => gateway.stop()));
  ipcMain.handle('gateway:restart', wrap(() => gateway.restart()));
  ipcMain.handle('gateway:models', wrap(() => gateway.modelsDetail()));
  ipcMain.handle('gateway:usage-log', wrap(({ limit }) => gateway.usageLog(limit)));
  ipcMain.handle('gateway:shares', wrap(() => gateway.sharesAll()));
  ipcMain.handle('gateway:share-create', wrap(({ name, providers }) => gateway.shareCreate(name, providers)));
  ipcMain.handle('gateway:share-update', wrap(({ id, patch }) => {
    return gateway.shareUpdate(id, (s) => {
      if (patch.name !== undefined) s.name = String(patch.name).slice(0, 40);
      if (patch.enabled !== undefined) s.enabled = !!patch.enabled;
      if (patch.providers !== undefined) {
        for (const [prov, p] of Object.entries(patch.providers)) {
          s.providers[prov] = { ...(s.providers[prov] || {}), ...p };
        }
      }
    });
  }));
  ipcMain.handle('gateway:share-remove', wrap(({ id }) => gateway.shareRemove(id)));
  ipcMain.handle('gateway:tunnel-start', wrap(() => {
    if (!gateway.running) throw new Error('请先启动网关');
    gateway.tunnel.start(gateway.server.port, gateway.config.tunnel?.host || 'bore.pub');
    return gateway.tunnel.status();
  }));
  ipcMain.handle('gateway:tunnel-stop', wrap(() => {
    gateway.tunnel.stop();
    return gateway.tunnel.status();
  }));
  ipcMain.handle('gateway:tunnel-status', wrap(() => gateway.tunnel.status()));
}

module.exports = { registerGatewayIpc };
