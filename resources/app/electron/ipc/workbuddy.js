const accountStore = require('../account-store');
const { detectWorkbuddyCredentials } = require('../workbuddy-reader');
const { wrap } = require('./utils');

function registerWorkbuddyIpc({ ipcMain, context }) {
  ipcMain.handle('workbuddy:detect-credentials', wrap(() => {
    const creds = detectWorkbuddyCredentials();
    if (creds.encrypted) {
      throw new Error('WorkBuddy 凭据已加密，请手动提取明文 Token 后再添加');
    }
    if (!creds.found || creds.error) {
      throw new Error(creds.error || '未找到 WorkBuddy 凭据');
    }
    return creds;
  }));

  ipcMain.handle('accounts:add-workbuddy', wrap(async (payload) => {
    const account = await accountStore.addWorkbuddyAccount(payload);
    context.notifyTraeAccountChanged();
    return account;
  }));
}

module.exports = { registerWorkbuddyIpc };
