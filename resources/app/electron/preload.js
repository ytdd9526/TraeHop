const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('traeAccounts', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  syncTraeAccount: () => ipcRenderer.invoke('accounts:sync-trae'),
  addAccount: (token, tokenExpiredAt) => ipcRenderer.invoke('accounts:add', { token, tokenExpiredAt }),
  addWorkbuddyAccount: (payload) => ipcRenderer.invoke('accounts:add-workbuddy', payload),
  detectWorkbuddyCredentials: () => ipcRenderer.invoke('workbuddy:detect-credentials'),
  importFromTrae: (edition) => ipcRenderer.invoke('accounts:import-from-trae', edition),
  listTraeSessions: () => ipcRenderer.invoke('accounts:list-trae-sessions'),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', { id }),
  updateAccountMeta: (id, meta) => ipcRenderer.invoke('accounts:update-meta', { id, ...meta }),
  bindMachineId: (id) => ipcRenderer.invoke('accounts:bind-machine', { id }),
  regenerateMachineId: (id) => ipcRenderer.invoke('accounts:regen-machine', { id }),
  getMachineInfo: () => ipcRenderer.invoke('accounts:get-machine'),
  resetMachineId: (edition) => ipcRenderer.invoke('machine:reset', { edition }),
  clearLoginState: (edition) => ipcRenderer.invoke('machine:clear-login', { edition }),
  checkSwitch: (id) => ipcRenderer.invoke('accounts:check-switch', { id }),
  exportAccounts: (opts) => ipcRenderer.invoke('accounts:export', opts || {}),
  pickImportFile: () => ipcRenderer.invoke('accounts:pick-import-file'),
  importAccountsContent: (opts) => ipcRenderer.invoke('accounts:import-content', opts || {}),
  switchAccount: (id, skipCheck) => ipcRenderer.invoke('accounts:switch', { id, skipCheck }),
  cleanAndSwitch: (id) => ipcRenderer.invoke('accounts:clean-and-switch', { id }),
  getUsageHistory: () => ipcRenderer.invoke('accounts:get-usage-history'),
  checkAlerts: () => ipcRenderer.invoke('accounts:notify-check'),
  getAccountUsage: (id) => ipcRenderer.invoke('accounts:get-usage', { id }),
  refreshProfiles: () => ipcRenderer.invoke('accounts:refresh-profiles'),
  refreshExpiredTokens: () => ipcRenderer.invoke('accounts:refresh-expired'),
  refreshAccountToken: (id) => ipcRenderer.invoke('accounts:refresh-token', { id }),
  startBrowserLogin: (accountId, region) => ipcRenderer.invoke('accounts:start-browser-login', { accountId, region }),
  cancelBrowserLogin: () => ipcRenderer.invoke('accounts:cancel-browser-login'),

  onLoginSuccess: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('login:success', handler);
    return () => ipcRenderer.removeListener('login:success', handler);
  },
  onLoginFailed: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('login:failed', handler);
    return () => ipcRenderer.removeListener('login:failed', handler);
  },
  onLoginCancelled: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('login:cancelled', handler);
    return () => ipcRenderer.removeListener('login:cancelled', handler);
  },
  onTraeAccountChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('trae:account-changed', handler);
    return () => ipcRenderer.removeListener('trae:account-changed', handler);
  },

  getTraePath: () => ipcRenderer.invoke('settings:get-trae-path'),
  setTraePath: (traePath) => ipcRenderer.invoke('settings:set-trae-path', { traePath }),
  scanTraePath: () => ipcRenderer.invoke('settings:scan-trae-path'),
  pickTraePath: () => ipcRenderer.invoke('settings:pick-trae-path'),
  pickBackupDir: () => ipcRenderer.invoke('settings:pick-backup-dir'),
  runBackupNow: () => ipcRenderer.invoke('settings:run-backup-now'),
  getLastBackup: () => ipcRenderer.invoke('settings:last-backup'),
  getPlatform: () => ipcRenderer.invoke('settings:platform'),
  getAppSettings: () => ipcRenderer.invoke('settings:get-app'),
  saveAppSettings: (settings) => ipcRenderer.invoke('settings:save-app', settings),

  scanClean: () => ipcRenderer.invoke('clean:scan'),
  startClean: () => ipcRenderer.invoke('clean:start'),
  cancelClean: () => ipcRenderer.invoke('clean:cancel'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onCleanLog: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('clean:log', handler);
    return () => ipcRenderer.removeListener('clean:log', handler);
  },

  getCheckinState: () => ipcRenderer.invoke('checkin:state'),
  runCheckin: () => ipcRenderer.invoke('checkin:run'),
  checkinOne: (id) => ipcRenderer.invoke('checkin:one', { id }),
  migrateSessions: (id) => ipcRenderer.invoke('migrate:sessions', { id }),
  onCheckinLog: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('checkin:log', handler);
    return () => ipcRenderer.removeListener('checkin:log', handler);
  },
  runRegister: (opts) => ipcRenderer.invoke('register:run', opts),
  cancelRegister: () => ipcRenderer.invoke('register:cancel'),
  onRegisterLog: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('register:log', handler);
    return () => ipcRenderer.removeListener('register:log', handler);
  },
  onMigrateLog: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('migrate:log', handler);
    return () => ipcRenderer.removeListener('migrate:log', handler);
  },

  gateway: {
    getConfig: () => ipcRenderer.invoke('gateway:config'),
    saveConfig: (partial) => ipcRenderer.invoke('gateway:save-config', { partial }),
    resetKey: () => ipcRenderer.invoke('gateway:reset-key'),
    getStatus: () => ipcRenderer.invoke('gateway:status'),
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    restart: () => ipcRenderer.invoke('gateway:restart'),
    getModels: () => ipcRenderer.invoke('gateway:models'),
    getUsageLog: (limit) => ipcRenderer.invoke('gateway:usage-log', { limit }),
    getShares: () => ipcRenderer.invoke('gateway:shares'),
    createShare: (name, providers) => ipcRenderer.invoke('gateway:share-create', { name, providers }),
    updateShare: (id, patch) => ipcRenderer.invoke('gateway:share-update', { id, patch }),
    removeShare: (id) => ipcRenderer.invoke('gateway:share-remove', { id }),
    startTunnel: () => ipcRenderer.invoke('gateway:tunnel-start'),
    stopTunnel: () => ipcRenderer.invoke('gateway:tunnel-stop'),
    tunnelStatus: () => ipcRenderer.invoke('gateway:tunnel-status'),
  },
});
