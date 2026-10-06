import { state, savePlatformCollapsed } from '../core/state.js';
import { $, $$ } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { api, unwrap } from '../core/api.js';
import { showToast } from './common.js';
import { refreshAccounts, renderAccountList, refreshOneAccountUsage, filterAccounts } from './accounts.js';
import { handleSwitch, handleCleanSwitch, handleCheckinOne, startRelogin, handleRefresh, refreshAccountToken } from './actions.js';
import { openAddDialog } from './add-account.js';
import { openDetailDialog } from './detail-dialog.js';
import { openMigrateDialog } from './migrate.js';
import { updateOverview } from './overview.js';

function syncSelectAllCheckbox() {
  const visible = filterAccounts(state.allAccounts).map((a) => a.id);
  const allSelected = visible.length > 0 && visible.every((id) => state.selectedIds.has(id));
  const cb = $('#select-all-accounts');
  if (cb) cb.checked = allSelected;
}

export function initGlobalEvents() {
  $('#btn-add').addEventListener('click', () => openAddDialog());

  $$('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.quotaFilter = chip.dataset.filter;
      $$('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderAccountList();
    });
  });

  $('#account-search').addEventListener('input', (e) => { state.accountSearch = e.target.value; renderAccountList(); });
  $('#account-sort').addEventListener('change', (e) => { state.accountSort = e.target.value; renderAccountList(); });

  $('#select-all-accounts').addEventListener('change', (e) => {
    const visible = filterAccounts(state.allAccounts).map((a) => a.id);
    if (e.target.checked) visible.forEach((id) => state.selectedIds.add(id));
    else visible.forEach((id) => state.selectedIds.delete(id));
    renderAccountList();
  });

  document.body.addEventListener('change', (e) => {
    if (e.target.classList.contains('account-select')) {
      const id = e.target.dataset.id;
      if (e.target.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      syncSelectAllCheckbox();
      renderAccountList();
    }
  });

  document.body.addEventListener('click', async (e) => {
    if (e.target.dataset.action === 'open-add') { openAddDialog(); return; }

    const platformToggle = e.target.closest('.platform-toggle');
    if (platformToggle) {
      const platform = platformToggle.dataset.platform;
      state.platformCollapsed[platform] = !state.platformCollapsed[platform];
      savePlatformCollapsed();
      renderAccountList();
      return;
    }

    const addPlatformAccount = e.target.closest('.btn-add-platform-account');
    if (addPlatformAccount) {
      openAddDialog(addPlatformAccount.dataset.platform);
      return;
    }

    const refreshOne = e.target.closest('.btn-refresh-one');
    if (refreshOne) {
      if (refreshOne.disabled) return;
      refreshOne.disabled = true;
      try {
        await refreshOneAccountUsage(refreshOne.dataset.id);
      } finally {
        const btn = document.querySelector(`.btn-refresh-one[data-id="${refreshOne.dataset.id}"]`);
        if (btn) btn.disabled = false;
      }
      return;
    }

    const checkinOneBtn = e.target.closest('.btn-checkin-one');
    if (checkinOneBtn) {
      await handleCheckinOne(checkinOneBtn.dataset.id);
      return;
    }

    const refreshTokenBtn = e.target.closest('.btn-refresh-token');
    if (refreshTokenBtn) {
      refreshTokenBtn.disabled = true;
      refreshTokenBtn.textContent = t('common.refreshing');
      try {
        await refreshAccountToken(refreshTokenBtn.dataset.id);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        refreshTokenBtn.disabled = false;
        refreshTokenBtn.textContent = t('accounts.refreshToken');
      }
      return;
    }

    const refreshTokenAlertBtn = e.target.closest('.btn-refresh-token-alert');
    if (refreshTokenAlertBtn) {
      const btn = refreshTokenAlertBtn;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = t('common.refreshing');
      try {
        await refreshAccountToken(btn.dataset.id);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
      return;
    }

    const reloginBtn = e.target.closest('.btn-relogin, .btn-relogin-alert');
    if (reloginBtn) {
      const account = state.allAccounts.find((a) => a.id === reloginBtn.dataset.id);
      const advance = !!(account?.tokenExpiringSoon && !account?.tokenExpired);
      await startRelogin(reloginBtn.dataset.id, { advance });
      return;
    }

    const detailBtn = e.target.closest('.btn-detail');
    if (detailBtn) { await openDetailDialog(detailBtn.dataset.id); return; }

    const switchBtn = e.target.closest('.btn-switch-account');
    if (switchBtn) {
      switchBtn.disabled = true;
      switchBtn.textContent = '…';
      try { await handleSwitch(switchBtn.dataset.id); }
      catch (err) { showToast(err.message, true); switchBtn.disabled = false; switchBtn.textContent = t('common.switch'); }
      return;
    }

    const cleanSwitchBtn = e.target.closest('.btn-clean-switch');
    if (cleanSwitchBtn) {
      cleanSwitchBtn.disabled = true;
      try { await handleCleanSwitch(cleanSwitchBtn.dataset.id); }
      catch (err) { showToast(err.message, true); }
      finally { cleanSwitchBtn.disabled = false; }
      return;
    }

    const migrateBtn = e.target.closest('.btn-migrate-sessions');
    if (migrateBtn) {
      if (migrateBtn.disabled) return;
      openMigrateDialog(migrateBtn.dataset.id);
      return;
    }

    const removeBtn = e.target.closest('.btn-remove');
    if (removeBtn) {
      if (!confirm(t('confirm.deleteAccount'))) return;
      try {
        delete state.usageMap[removeBtn.dataset.id];
        state.selectedIds.delete(removeBtn.dataset.id);
        await unwrap(api.removeAccount(removeBtn.dataset.id));
        showToast(t('toast.deleted'));
        await refreshAccounts();
      } catch (err) { showToast(err.message, true); }
    }
  });

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.overview-tab');
    if (!tab) return;
    const ed = tab.dataset.edition || 'all';
    if (state.overviewEdition === ed) return;
    state.overviewEdition = ed;
    document.querySelectorAll('.overview-tab').forEach((t) => t.classList.toggle('active', t.dataset.edition === ed));
    updateOverview(state.allAccounts);
  });

  $('#btn-refresh-usage').addEventListener('click', (e) => handleRefresh(e.target));
  $('#btn-refresh-overview').addEventListener('click', (e) => handleRefresh(e.target));

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      const { scheduleRefreshAccounts } = await import('./accounts.js');
      scheduleRefreshAccounts();
    }
  });
}

export function initLocaleChangeListener() {
  window.addEventListener('traehop:localechange', async () => {
    const { applyTheme, updateAutoRefreshStatus, refreshSettingsLabels } = await import('./settings.js');
    const { setDisclaimerMode } = await import('./disclaimer.js');
    const { setCleanRunning } = await import('./clean.js');
    const { renderAccountList } = await import('./accounts.js');
    const { loadUsageHistory } = await import('./history.js');
    const { renderMachinePanel } = await import('./machine.js');
    const { updateOverview } = await import('./overview.js');

    applyTheme(state.appSettings.theme);
    updateAutoRefreshStatus();
    refreshSettingsLabels();
    setDisclaimerMode(state.disclaimerRequired);
    setCleanRunning(state.cleanCleaning);
    renderAccountList();
    if (state.currentPage === 'overview') {
      updateOverview(state.allAccounts);
      loadUsageHistory();
    }
    if (state.machineInfoCache) renderMachinePanel(state.machineInfoCache);
  });
}
