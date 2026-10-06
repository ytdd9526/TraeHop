import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { accountLabel } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts, loadCheckinState, renderAccountList } from './accounts.js';

export async function confirmSwitchWarnings(check) {
  if (!check.warnings?.length) return true;
  return confirm(t('confirm.switchWarnings', {
    warnings: check.warnings.map((w) => `• ${w}`).join('\n'),
  }));
}

export async function handleSwitch(id, skipCheck = false) {
  if (!skipCheck) {
    const check = await unwrap(api.checkSwitch(id));
    if (!check.canSwitch) throw new Error(check.blockers.join('；'));
    if (!(await confirmSwitchWarnings(check))) return null;
  }
  const result = await unwrap(api.switchAccount(id, skipCheck));
  showToast(t('toast.switched', { email: result.email || t('common.account') }));
  await refreshAccounts();
  return result;
}

export async function handleCleanSwitch(id) {
  const check = await unwrap(api.checkSwitch(id));
  if (!check.canSwitch) throw new Error(check.blockers.join('；'));
  const msg = [
    t('common.advanced'),
    '',
    t('clean.cleanSwitchConfirm'),
    t('clean.cleanSwitchWarn'),
    '',
    ...(check.warnings.length ? [...check.warnings.map((w) => `• ${w}`), ''] : []),
    t('common.continue'),
  ].join('\n');
  if (!confirm(msg)) return;

  showToast(t('clean.cleanSwitchProgress'));
  const result = await unwrap(api.cleanAndSwitch(id));
  showToast(t('toast.cleanSwitched', { email: result.email || t('common.account') }));
  await refreshAccounts();
}

export function setCheckinOneLoading(id, loading) {
  const btn = document.querySelector(`.btn-checkin-one[data-id="${id}"]`);
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('is-loading', loading);
  btn.textContent = loading ? '' : '✓';
}

export async function handleCheckinOne(id) {
  if (state.checkinLoadingIds.has(id)) return;
  state.checkinLoadingIds.add(id);
  setCheckinOneLoading(id, true);
  try {
    const result = await unwrap(api.checkinOne(id));
    await loadCheckinState();
    renderAccountList();
    const pointsText = result.points ? ` +${result.points}` : '';
    if (result.status === 'checked') showToast(t('toast.checkinOneSuccess', { points: pointsText }));
    else if (result.status === 'already') showToast(t('toast.checkinOneAlready'));
    else if (result.status === 'rate') showToast(t('toast.checkinOneRate'), true);
    else showToast(result.message || t('toast.checkinOneFailed'), true);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    state.checkinLoadingIds.delete(id);
    setCheckinOneLoading(id, false);
  }
}

export async function handleRefresh(btn) {
  const { loadAllUsage } = await import('./accounts.js');
  const label = t('common.refreshUsage');
  btn.disabled = true;
  btn.textContent = t('common.refreshing');
  try {
    await loadAllUsage();
    showToast(t('toast.usageRefreshed'));
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export async function refreshAccountToken(id) {
  const result = await unwrap(api.refreshAccountToken(id));
  showToast(
    result.stillExpiringSoon
      ? t('toast.tokenRefreshedStillExpiring')
      : t('toast.tokenRefreshed'),
    !!result.stillExpiringSoon
  );
  await refreshAccounts();
  return result;
}

export async function startRelogin(accountId, { advance = false } = {}) {
  state.reloginAccountId = accountId;
  const account = state.allAccounts.find((a) => a.id === accountId);
  const label = account?.email || account?.name || t('toast.targetAccount');
  try {
    await unwrap(api.startBrowserLogin(accountId));
    showToast(advance ? t('toast.prelogin', { label }) : t('toast.browserLogin', { label }));
  } catch (err) {
    showToast(err.message, true);
    state.reloginAccountId = null;
  }
}
