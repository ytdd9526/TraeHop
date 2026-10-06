import { state, RING_CIRCUMFERENCE } from '../core/state.js';
import { $, escapeHtml, formatRefreshTime, formatResetCountdown, formatDateTime } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { computeStats, getAccountQuotaStatus } from './stats.js';
import { loadUsageHistory } from './history.js';

export function renderExpiryAlerts() {
  const panel = $('#expiry-alerts');
  const list = $('#expiry-alert-list');
  if (!panel || !list) return;
  if (state.appSettings.notifyTokenExpiry === false) {
    panel.classList.add('hidden');
    return;
  }

  const alerts = state.allAccounts
    .filter((a) => a.tokenExpired || (a.tokenExpiringSoon && !a.tokenExpired))
    .map((a) => {
      if (a.tokenExpired) {
        return {
          accountId: a.id,
          email: a.email || a.name,
          message: t('accounts.alertExpired'),
          action: t('accounts.relogin'),
          actionClass: 'btn-relogin-alert',
        };
      }
      if (a.hasCookies) {
        return {
          accountId: a.id,
          email: a.email || a.name,
          message: t('accounts.alertExpiringRefresh'),
          action: t('accounts.refreshToken'),
          actionClass: 'btn-refresh-token-alert',
        };
      }
      return {
        accountId: a.id,
        email: a.email || a.name,
        message: t('accounts.alertExpiringPrelogin'),
        action: t('accounts.prelogin'),
        actionClass: 'btn-relogin-alert',
      };
    });

  if (!alerts.length) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  list.innerHTML = alerts
    .map(
      (a) =>
        `<li><span>${escapeHtml(a.email || t('common.account'))}</span><span class="alert-msg">${escapeHtml(a.message)}</span><button class="btn-text ${a.actionClass}" data-id="${a.accountId}">${escapeHtml(a.action)}</button></li>`
    )
    .join('');
}

export function updateOverview(accounts) {
  const loading = $('#overview-loading');
  const empty = $('#overview-empty');
  const content = $('#overview-content');
  const loadingText = loading?.querySelector('.loading-text');
  const navCount = $('#nav-account-count');
  if (navCount) navCount.textContent = (state.initialLoading || state.accountsSyncing) ? '…' : accounts.length;

  if (state.initialLoading || state.accountsSyncing) {
    if (loadingText) {
      loadingText.textContent = state.initialLoading ? t('overview.detecting') : state.accountsSyncMessage;
    }
    loading?.classList.remove('hidden');
    empty.classList.add('hidden');
    content.classList.add('hidden');
    return;
  }

  loading?.classList.add('hidden');

  if (!accounts.length) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }

  const filtered = state.overviewEdition === 'all'
    ? accounts
    : accounts.filter((a) => (a.platform || 'trae') === state.overviewEdition);

  if (!filtered.length) {
    content.classList.remove('hidden');
    $('#stat-total').textContent = 0;
    $('#stat-active').textContent = 0;
    $('#stat-no-quota').textContent = 0;
    $('#stat-expired').textContent = 0;
    $('#stat-expiring').textContent = 0;
    $('#stat-left').textContent = '—';
    $('#stat-used').textContent = '—';
    $('#stat-limit').textContent = '—';
    $('#stat-used-pct').textContent = '0%';
    $('#stat-used-pct-inline').textContent = '0%';
    $('#stat-used-inline').textContent = '—';
    $('#stat-limit-inline').textContent = '—';
    $('#stat-active-ratio').textContent = '—';
    $('#stat-no-quota-ratio').textContent = '—';
    $('#stat-limit-unit').textContent = t('overview.fastRequests');
    $('#stat-reset').textContent = '—';
    $('#last-refresh-time').textContent = formatRefreshTime(state.lastRefreshTime);
    renderExpiryAlerts();
    const ring = $('#ring-progress');
    ring.style.strokeDashoffset = RING_CIRCUMFERENCE;
    ring.style.stroke = 'var(--border)';
    const stripFill = $('#strip-progress-fill');
    if (stripFill) { stripFill.style.width = '0%'; stripFill.style.background = 'var(--border)'; }
    return;
  }

  empty.classList.add('hidden');
  content.classList.remove('hidden');

  const s = computeStats(filtered);
  $('#stat-total').textContent = s.total;
  $('#stat-active').textContent = s.hasQuota;
  $('#stat-no-quota').textContent = s.noQuota;
  $('#stat-expired').textContent = s.expired;
  $('#stat-expiring').textContent = s.expiring;
  $('#stat-left').textContent = s.fmt(s.totalLeft);
  $('#stat-used').textContent = s.fmt(s.totalUsed);
  $('#stat-limit').textContent = s.fmt(s.totalLimit);
  $('#stat-used-pct').textContent = `${s.usedPct}%`;
  $('#stat-used-pct-inline').textContent = `${s.usedPct}%`;
  $('#stat-used-inline').textContent = s.fmt(s.totalUsed);
  $('#stat-limit-inline').textContent = s.fmt(s.totalLimit);
  $('#stat-active-ratio').textContent = s.total ? `${Math.round((s.hasQuota / s.total) * 100)}%` : '—';
  $('#stat-no-quota-ratio').textContent = s.total ? `${Math.round((s.noQuota / s.total) * 100)}%` : '—';
  $('#stat-limit-unit').textContent = s.anyDollar ? t('overview.dollarUsage') : t('overview.fastRequests');
  $('#stat-reset').textContent = s.nearestReset ? `${formatResetCountdown(s.nearestReset)} · ${formatDateTime(s.nearestReset)}` : '—';
  $('#last-refresh-time').textContent = formatRefreshTime(state.lastRefreshTime);
  renderExpiryAlerts();

  const ring = $('#ring-progress');
  ring.style.strokeDashoffset = RING_CIRCUMFERENCE - (s.usedPct / 100) * RING_CIRCUMFERENCE;
  ring.style.stroke = s.usedPct >= 90 ? 'var(--red)' : s.usedPct >= 60 ? 'var(--amber)' : 'var(--primary)';

  const stripFill = $('#strip-progress-fill');
  if (stripFill) {
    stripFill.style.width = `${s.usedPct}%`;
    stripFill.style.background = s.usedPct >= 90 ? 'var(--red)' : s.usedPct >= 60 ? 'var(--amber)' : 'var(--primary)';
  }
}
