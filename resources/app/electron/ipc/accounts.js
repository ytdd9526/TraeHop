const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const { APP_SLUG } = require('../app-brand');
const mainI18n = require('../i18n');
const accountStore = require('../account-store');
const { readCurrentTraeToken, readAllLoggedInSessions } = require('../trae-reader');
const { switchTraeAccount, readMachineInfo, resetMachineId, clearLoginState, killTrae } = require('../trae-switcher');
const { getPlatformConfig } = require('../platform-config');
const { isEncryptedBackup } = require('../backup-crypto');
const { checkBeforeSwitch } = require('../switch-check');
const { startBrowserLogin, closeBrowserLogin } = require('../browser-login');
const { wrap } = require('./utils');

async function switchAccount(id, skipCheck = false) {
  let warnings = [];
  if (!skipCheck) {
    const check = await checkBeforeSwitch(id);
    if (!check.canSwitch) throw new Error(check.blockers.join('；'));
    warnings = check.warnings;
  }

  const account = accountStore.getAccount(id);
  await accountStore.ensureValidToken(id);
  const result = await switchTraeAccount(account);
  accountStore.setCurrentAccount(id);
  return { email: account.email, ...result, warnings };
}

function registerAccountsIpc({ ipcMain, context }) {
  const { notifyTraeAccountChanged, sendNotification, getMainWindow, getTrayApi, getReloginAccountId, setReloginAccountId } = context;

  ipcMain.handle('accounts:list', wrap(() => accountStore.listAccounts()));
  ipcMain.handle('accounts:refresh-expired', wrap(() => accountStore.refreshAllExpiredTokens()));
  ipcMain.handle('accounts:refresh-token', wrap(({ id }) => accountStore.refreshAccountToken(id)));
  ipcMain.handle('accounts:sync-trae', wrap(() => accountStore.syncCurrentFromTrae()));
  ipcMain.handle('accounts:add', wrap(async ({ token, tokenExpiredAt }) =>
    accountStore.addAccountByToken(token, { tokenExpiredAt })));

  ipcMain.handle('accounts:list-trae-sessions', wrap(async () => {
    const sessions = await readAllLoggedInSessions();
    return sessions.map((s) => ({
      edition: s.edition,
      editionLabel: s.editionLabel,
      clientDir: s.clientDir,
      email: s.email,
      name: s.name,
    }));
  }));

  ipcMain.handle('accounts:import-from-trae', wrap(async (edition) => {
    const session = await readCurrentTraeToken(edition === 'intl' ? 'intl' : edition === 'cn' ? 'cn' : undefined);
    const config = getPlatformConfig(session.edition);
    let machineId = null;
    if (config && fs.existsSync(config.machineIdPath)) {
      machineId = fs.readFileSync(config.machineIdPath, 'utf8').trim();
    }
    const account = await accountStore.addAccountByToken(session.token, {
      email: session.email,
      name: session.name,
      username: session.username,
      avatarUrl: session.avatarUrl,
      tokenExpiredAt: session.tokenExpiredAt,
      encryptedAuth: session.encryptedAuth,
      encryptedEntitlement: session.encryptedEntitlement,
      encryptedServerData: session.encryptedServerData,
      machineId,
      edition: session.edition,
    });
    return { account, source: session.source };
  }));

  ipcMain.handle('accounts:remove', wrap(({ id }) => accountStore.removeAccount(id)));

  ipcMain.handle('accounts:update-meta', wrap(({ id, note, group }) => {
    accountStore.updateAccountMeta(id, { note, group });
    getTrayApi()?.rebuild();
  }));

  ipcMain.handle('accounts:bind-machine', wrap(({ id }) => accountStore.bindMachineId(id)));
  ipcMain.handle('accounts:regen-machine', wrap(({ id }) => accountStore.regenerateMachineId(id)));
  ipcMain.handle('accounts:get-machine', wrap(async () => {
    const infos = [];
    for (const edition of ['cn', 'intl']) {
      const config = getPlatformConfig(edition);
      infos.push({
        ...(await readMachineInfo(edition)),
        editionLabel: config?.editionLabel || edition,
        clientDir: config?.clientDir || '',
      });
    }
    return infos;
  }));

  ipcMain.handle('machine:reset', wrap(({ edition } = {}) => {
    const result = resetMachineId(edition === 'intl' ? 'intl' : 'cn');
    notifyTraeAccountChanged();
    return result;
  }));

  ipcMain.handle('machine:clear-login', wrap(({ edition } = {}) => {
    const result = clearLoginState(edition === 'intl' ? 'intl' : 'cn');
    notifyTraeAccountChanged();
    return result;
  }));

  ipcMain.handle('accounts:check-switch', wrap(({ id }) => checkBeforeSwitch(id)));

  ipcMain.handle('accounts:export', wrap(async ({ ids, password } = {}) => {
    const mainWindow = getMainWindow();
    const payload = accountStore.exportAccountsData(ids);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: mainI18n.t('dialog.exportAccounts'),
      defaultPath: `${APP_SLUG}-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: mainI18n.t('dialog.backupFilter'), extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, accountStore.serializeExport(payload, password || ''), 'utf8');
    return { path: result.filePath, count: payload.accounts.length, encrypted: !!password };
  }));

  ipcMain.handle('accounts:pick-import-file', wrap(async () => {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mainI18n.t('importDialog.title'),
      filters: [{ name: mainI18n.t('dialog.backupFilter'), extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths[0]) return null;

    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf8');
    let encrypted = false;
    try {
      encrypted = isEncryptedBackup(JSON.parse(content));
    } catch {
      throw new Error('无法解析备份文件');
    }

    return {
      fileName: path.basename(filePath),
      content,
      encrypted,
    };
  }));

  ipcMain.handle('accounts:import-content', wrap(async ({ content, mode, password } = {}) => {
    if (!content) throw new Error('未选择备份文件');
    const parsed = accountStore.parseImportFileContent(content, password || '');
    return accountStore.importAccounts(parsed, mode || 'skip');
  }));

  ipcMain.handle('accounts:switch', wrap(({ id, skipCheck }) => switchAccount(id, skipCheck)));

  ipcMain.handle('accounts:clean-and-switch', wrap(async ({ id }) => {
    const check = await checkBeforeSwitch(id);
    if (!check.canSwitch) throw new Error(check.blockers.join('；'));

    const target = accountStore.getAccount(id);
    if (target.platform === 'workbuddy') {
      throw new Error('WorkBuddy 账号不支持切换 Trae IDE 会话');
    }
    const edition = accountStore.editionOfAccount(target);
    killTrae(edition);
    await clearLoginState(edition);

    const account = accountStore.getAccount(id);
    await accountStore.ensureValidToken(id);
    const result = await switchTraeAccount(account);
    accountStore.setCurrentAccount(id);
    return { email: account.email, ...result, warnings: check.warnings };
  }));

  ipcMain.handle('accounts:get-usage-history', wrap(() => accountStore.getUsageHistoryForOverview()));

  ipcMain.handle('accounts:notify-check', wrap(async () => {
    const settings = accountStore.getSettings();
    const accounts = await accountStore.listAccounts();
    const alerts = [];
    const notifiedKeys = context.getNotifiedKeys();

    for (const a of accounts) {
      if (!settings.notifyTokenExpiry) continue;
      if (a.tokenExpired) {
        const key = `expired:${a.id}`;
        if (!notifiedKeys.has(key)) {
          alerts.push({ type: 'expired', accountId: a.id, email: a.email, message: 'Token 已过期' });
          notifiedKeys.add(key);
        }
      } else if (a.tokenExpiringSoon) {
        const key = `expiring:${a.id}`;
        if (!notifiedKeys.has(key)) {
          alerts.push({ type: 'expiring', accountId: a.id, email: a.email, message: 'Token 即将过期' });
          notifiedKeys.add(key);
        }
      }
    }

    return alerts;
  }));

  ipcMain.handle('accounts:get-usage', wrap(async ({ id }) => {
    const summary = await accountStore.getAccountUsage(id);
    const settings = accountStore.getSettings();
    const account = accountStore.getAccount(id);

    if (settings.notifyLowQuota && summary) {
      const limit = summary.displayLimit ?? 0;
      const left = summary.displayLeft ?? 0;
      const pctLeft = limit > 0 ? (left / limit) * 100 : 0;
      if (pctLeft <= settings.lowQuotaThreshold && pctLeft >= 0) {
        const key = `low:${id}:${Math.floor(pctLeft)}`;
        const notifiedKeys = context.getNotifiedKeys();
        if (!notifiedKeys.has(key)) {
          sendNotification('用量提醒', `${account.email || account.name} 剩余用量较低`);
          notifiedKeys.add(key);
        }
      }
    }

    return summary;
  }));

  ipcMain.handle('accounts:start-browser-login', wrap(async ({ accountId, region } = {}) => {
    setReloginAccountId(accountId || null);
    startBrowserLogin({
      parentWindow: getMainWindow(),
      region: region || 'intl',
      onSuccess: async (token, cookies, expiredAt) => {
        const extras = { cookies, tokenExpiredAt: expiredAt || undefined };
        if (getReloginAccountId()) {
          const account = await accountStore.updateAccountToken(getReloginAccountId(), token, extras);
          setReloginAccountId(null);
          getTrayApi()?.rebuild();
          return account;
        }
        const account = await accountStore.addAccountByToken(token, extras);
        getTrayApi()?.rebuild();
        return account;
      },
      onFailed: () => {},
      onCancelled: () => {
        setReloginAccountId(null);
      },
    });
    return { started: true, relogin: !!accountId };
  }));

  ipcMain.handle('accounts:refresh-profiles', wrap(() => accountStore.refreshAllProfiles()));
  ipcMain.handle('accounts:cancel-browser-login', wrap(() => {
    closeBrowserLogin();
    setReloginAccountId(null);
  }));
}

module.exports = { registerAccountsIpc, switchAccount };
