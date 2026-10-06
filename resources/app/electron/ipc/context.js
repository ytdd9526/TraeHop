const { Notification } = require('electron');

const state = {
  mainWindow: null,
  trayApi: null,
  reloginAccountId: null,
  activeCleaner: null,
  checkinRunning: false,
  migrationRunning: false,
  registerRunning: false,
  notifiedKeys: new Set(),
  storageWatcher: new Set(),
  autoBackupTimer: null,
};

function getMainWindow() {
  return state.mainWindow;
}

function setMainWindow(win) {
  state.mainWindow = win;
}

function getTrayApi() {
  return state.trayApi;
}

function setTrayApi(api) {
  state.trayApi = api;
}

function notifyTraeAccountChanged() {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('trae:account-changed');
  }
  state.trayApi?.rebuild();
}

function sendNotification(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

function getReloginAccountId() {
  return state.reloginAccountId;
}

function setReloginAccountId(id) {
  state.reloginAccountId = id;
}

function getActiveCleaner() {
  return state.activeCleaner;
}

function setActiveCleaner(cleaner) {
  state.activeCleaner = cleaner;
}

function isCheckinRunning() {
  return state.checkinRunning;
}

function setCheckinRunning(v) {
  state.checkinRunning = v;
}

function isMigrationRunning() {
  return state.migrationRunning;
}

function setMigrationRunning(v) {
  state.migrationRunning = v;
}

function isRegisterRunning() {
  return state.registerRunning;
}

function setRegisterRunning(v) {
  state.registerRunning = v;
}

function getStorageWatcher() {
  return state.storageWatcher;
}

function getAutoBackupTimer() {
  return state.autoBackupTimer;
}

function setAutoBackupTimer(timer) {
  state.autoBackupTimer = timer;
}

let autoBackupTimerHandler = null;

function setupAutoBackupTimer() {
  if (autoBackupTimerHandler) autoBackupTimerHandler();
}

function setAutoBackupTimerHandler(handler) {
  autoBackupTimerHandler = handler;
}

function getNotifiedKeys() {
  return state.notifiedKeys;
}

module.exports = {
  getMainWindow,
  setMainWindow,
  getTrayApi,
  setTrayApi,
  notifyTraeAccountChanged,
  sendNotification,
  getReloginAccountId,
  setReloginAccountId,
  getActiveCleaner,
  setActiveCleaner,
  isCheckinRunning,
  setCheckinRunning,
  isMigrationRunning,
  setMigrationRunning,
  isRegisterRunning,
  setRegisterRunning,
  getStorageWatcher,
  getAutoBackupTimer,
  setAutoBackupTimer,
  setupAutoBackupTimer,
  setAutoBackupTimerHandler,
  getNotifiedKeys,
};
