import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t, setLocale, initI18n, getLocale } from '../core/i18n.js';
import { $, $$, formatTs } from '../core/utils.js';
import { showToast } from './common.js';
import { renderAccountList } from './accounts.js';
import { loadMachinePanel } from './machine.js';
import { renderExpiryAlerts } from './overview.js';
import { scanCleanSize } from './clean.js';

const traePathEl = $('#trae-path');

export function applyTheme(theme) {
  const mode = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('traehop-theme', mode); } catch { /* */ }
  const label = $('#theme-toggle-label');
  if (label) label.textContent = mode === 'dark' ? t('theme.darkMode') : t('theme.lightMode');
  $$('.theme-segment-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === mode);
  });
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveSettings({ theme: next });
}

export function updateAutoRefreshStatus() {
  const el = $('#auto-refresh-status');
  if (!state.appSettings.autoRefreshEnabled) { el.textContent = t('settings.autoRefreshOff'); return; }
  el.textContent = t('settings.autoRefreshOn', { n: state.appSettings.autoRefreshIntervalMinutes })
    + (state.lastRefreshTime ? t('settings.autoRefreshLast', { time: formatRefreshTime(state.lastRefreshTime) }) : '');
}

function formatRefreshTime(date) {
  if (!date) return '—';
  return date.toLocaleTimeString(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function refreshSettingsLabels() {
  $('#backup-dir').textContent = state.appSettings.autoBackupDir || t('common.notSet');
  $('#last-backup-time').textContent = state.lastBackupTs
    ? t('settings.lastBackup', { time: formatTs(state.lastBackupTs) })
    : t('settings.neverBackedUp');
  traePathEl.textContent = state.cachedTraePath || t('common.notConfigured');
}

export async function loadSettings() {
  state.appSettings = await unwrap(api.getAppSettings());
  const lang = state.appSettings.language || getLocale();
  initI18n(lang);
  $('#setting-language').value = lang;
  applyTheme(state.appSettings.theme);
  $('#setting-auto-refresh').checked = state.appSettings.autoRefreshEnabled;
  $('#setting-interval').value = String(state.appSettings.autoRefreshIntervalMinutes);
  $('#setting-notify-quota').checked = state.appSettings.notifyLowQuota;
  $('#setting-notify-expiry').checked = state.appSettings.notifyTokenExpiry;
  $('#setting-quota-threshold').value = String(state.appSettings.lowQuotaThreshold);
  $('#setting-auto-backup').checked = state.appSettings.autoBackupEnabled;
  $('#setting-backup-interval').value = String(state.appSettings.autoBackupIntervalHours);
  state.lastBackupTs = await unwrap(api.getLastBackup());
  refreshSettingsLabels();
  setupAutoRefresh();
}

export async function saveSettings(partial) {
  state.appSettings = await unwrap(api.saveAppSettings(partial));
  setupAutoRefresh();
}

export function setupAutoRefresh() {
  if (state.autoRefreshTimer) { clearInterval(state.autoRefreshTimer); state.autoRefreshTimer = null; }
  if (state.appSettings.autoRefreshEnabled && state.allAccounts.length) {
    state.autoRefreshTimer = setInterval(() => {
      import('./accounts.js').then(({ loadAllUsage }) => loadAllUsage(true));
    }, state.appSettings.autoRefreshIntervalMinutes * 60000);
  }
  updateAutoRefreshStatus();
}

export async function loadTraePath() {
  state.cachedTraePath = await unwrap(api.getTraePath());
  traePathEl.textContent = state.cachedTraePath || t('common.notConfigured');
}

export function initSettingsEvents() {
  $('#btn-theme-toggle').addEventListener('click', toggleTheme);
  $$('.theme-segment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      saveSettings({ theme: btn.dataset.theme });
    });
  });

  $('#setting-language').addEventListener('change', async (e) => {
    const lang = e.target.value;
    setLocale(lang);
    await saveSettings({ language: lang });
    applyTheme(state.appSettings.theme);
    updateAutoRefreshStatus();
    refreshSettingsLabels();
    const { setDisclaimerMode } = await import('./disclaimer.js');
    setDisclaimerMode(state.disclaimerRequired);
    const { setCleanRunning } = await import('./clean.js');
    setCleanRunning(state.cleanCleaning);
    renderAccountList();
    const { loadUsageHistory } = await import('./accounts.js');
    loadUsageHistory();
    if (state.machineInfoCache) loadMachinePanel();
  });

  $('#setting-auto-refresh').addEventListener('change', (e) => saveSettings({ autoRefreshEnabled: e.target.checked }));
  $('#setting-interval').addEventListener('change', (e) => saveSettings({ autoRefreshIntervalMinutes: Math.max(5, Number(e.target.value)) }));
  $('#setting-notify-quota').addEventListener('change', (e) => saveSettings({ notifyLowQuota: e.target.checked }));
  $('#setting-notify-expiry').addEventListener('change', async (e) => {
    await saveSettings({ notifyTokenExpiry: e.target.checked });
    renderExpiryAlerts();
  });
  $('#setting-quota-threshold').addEventListener('change', (e) => saveSettings({ lowQuotaThreshold: Number(e.target.value) }));
  $('#setting-auto-backup').addEventListener('change', (e) => saveSettings({ autoBackupEnabled: e.target.checked }));
  $('#setting-backup-interval').addEventListener('change', (e) => saveSettings({ autoBackupIntervalHours: Number(e.target.value) }));

  $('#btn-pick-backup-dir').addEventListener('click', async () => {
    try {
      const dir = await unwrap(api.pickBackupDir());
      if (dir) {
        await saveSettings({ autoBackupDir: dir });
        $('#backup-dir').textContent = dir;
        showToast(t('toast.backupDirSaved'));
      }
    } catch (err) { showToast(err.message, true); }
  });

  $('#btn-backup-now').addEventListener('click', async () => {
    try {
      const r = await unwrap(api.runBackupNow());
      if (r.skipped) { showToast(r.reason, true); return; }
      showToast(t('toast.backupDone', { n: r.count }));
      state.lastBackupTs = Date.now();
      refreshSettingsLabels();
    } catch (err) { showToast(err.message, true); }
  });

  $('#btn-scan-path').addEventListener('click', async () => {
    try {
      state.cachedTraePath = await unwrap(api.scanTraePath());
      traePathEl.textContent = state.cachedTraePath;
      showToast(t('toast.traeFound'));
    }
    catch (err) { showToast(err.message, true); }
  });

  $('#btn-pick-path').addEventListener('click', async () => {
    try {
      const p = await unwrap(api.pickTraePath());
      if (p) { state.cachedTraePath = p; traePathEl.textContent = p; showToast(t('toast.pathSaved')); }
    } catch (err) { showToast(err.message, true); }
  });

  $('#btn-refresh-machine').addEventListener('click', loadMachinePanel);
}
