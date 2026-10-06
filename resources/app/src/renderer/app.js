import { state } from './core/state.js';
import { api, unwrap } from './core/api.js';
import { t, getI18nReady, detectLocale } from './core/i18n.js';
import { $ } from './core/utils.js';
import { showToast } from './ui/common.js';
import { refreshAccounts, renderAccountList, renderUI } from './ui/accounts.js';
import { loadSettings, loadTraePath } from './ui/settings.js';
import { ensureDisclaimerAccepted } from './ui/disclaimer.js';
import { initNavigationEvents } from './ui/navigation.js';
import { initGlobalEvents, initLocaleChangeListener } from './ui/events.js';
import { initAddAccountEvents } from './ui/add-account.js';
import { initImportExportEvents } from './ui/import-export.js';
import { initSettingsEvents } from './ui/settings.js';
import { initCleanEvents } from './ui/clean.js';
import { initCheckinEvents } from './ui/checkin.js';
import { initMigrateEvents } from './ui/migrate.js';
import { initRegisterEvents } from './ui/register.js';
import { initMachineEvents } from './ui/machine.js';
import { initDetailDialogEvents } from './ui/detail-dialog.js';
import { initDisclaimerEvents } from './ui/disclaimer.js';
import { initGatewayEvents } from './ui/gateway.js';
import { initModelsEvents } from './ui/models.js';

function initAccountsSwitchTip() {
  const tip = $('#accounts-switch-tip');
  if (!tip) return;
  try {
    if (localStorage.getItem('traehop-switch-tip-dismissed') === '1') {
      tip.classList.add('hidden');
    }
  } catch { /* */ }
}

function initSwitchTipEvent() {
  $('#btn-dismiss-switch-tip')?.addEventListener('click', () => {
    $('#accounts-switch-tip')?.classList.add('hidden');
    try { localStorage.setItem('traehop-switch-tip-dismissed', '1'); } catch { /* */ }
  });
}

function initLoginListeners() {
  api.onLoginSuccess(async (data) => {
    const wasRelogin = !!state.reloginAccountId;
    state.browserLoginActive = false;
    state.reloginAccountId = null;
    const addDialog = $('#add-dialog');
    if (addDialog.open) addDialog.close();
    showToast(wasRelogin ? t('toast.tokenUpdated') : t('toast.loginSuccess', { email: data.email || t('toast.newAccount') }));
    if (!wasRelogin) {
      const { switchPage } = await import('./ui/navigation.js');
      switchPage('accounts');
    }
    try {
      await refreshAccounts({
        syncMessage: wasRelogin ? t('sync.updating') : t('sync.adding'),
      });
    } catch (err) {
      showToast(err.message, true);
    }
  });

  api.onLoginFailed((msg) => {
    state.browserLoginActive = false;
    state.reloginAccountId = null;
    $('#browser-login-status').classList.remove('hidden');
    $('#browser-login-status').textContent = msg;
  });

  api.onLoginCancelled(() => {
    state.browserLoginActive = false;
    state.reloginAccountId = null;
  });

  api.onTraeAccountChanged(async () => {
    const { scheduleRefreshAccounts } = await import('./ui/accounts.js');
    scheduleRefreshAccounts();
  });
}

function bindAllEvents() {
  initNavigationEvents();
  initGlobalEvents();
  initAddAccountEvents();
  initImportExportEvents();
  initSettingsEvents();
  initCleanEvents();
  initCheckinEvents();
  initMigrateEvents();
  initRegisterEvents();
  initMachineEvents();
  initDetailDialogEvents();
  initDisclaimerEvents();
  initGatewayEvents();
  initModelsEvents();
  initLocaleChangeListener();
  initSwitchTipEvent();
}

export async function initApp() {
  try {
    await getI18nReady();
    initAccountsSwitchTip();
    bindAllEvents();
    initLoginListeners();
    await loadSettings();
    if (!state.appSettings.language) {
      const { saveSettings } = await import('./ui/settings.js');
      await saveSettings({ language: detectLocale() });
    }
    await ensureDisclaimerAccepted();
    await loadTraePath();
    await refreshAccounts();
    renderUI();
    const p = await unwrap(api.getTraePath());
    if (!p) {
      try {
        state.cachedTraePath = await unwrap(api.scanTraePath());
        $('#trae-path').textContent = state.cachedTraePath;
      } catch { /* */ }
    }
  } catch (err) {
    state.initialLoading = false;
    renderAccountList();
    showToast(err.message, true);
  }
}
