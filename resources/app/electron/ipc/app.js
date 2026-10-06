function registerAppIpc({ ipcMain, app }) {
  ipcMain.handle('app:quit', () => {
    app.quit();
  });
}

module.exports = { registerAppIpc };
