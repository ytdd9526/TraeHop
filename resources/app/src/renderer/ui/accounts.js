import { state, PLATFORM_TYPES, PLATFORM_ICONS } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $, escapeHtml, asyncPool, rafDebounce } from '../core/utils.js';
import { showToast, accountsLoadingHtml, setAccountsToolbarBusy } from './common.js';
import { getUsageMetrics, getAccountQuotaStatus, computeStats } from './stats.js';
import { updateOverview } from './overview.js';
import { loadUsageHistory } from './history.js';

const accountList = $('#account-list');
const renderAccountListRaf = rafDebounce(renderAccountListImpl);

function htmlToFragment(html) {
  const range = document.createRange();
  return range.createContextualFragment(html);
}

export function formatFilterCount(filtered, total, selCount) {
  if (state.initialLoading || state.accountsSyncing) {
    return state.accountsSyncing ? t('common.syncing') : t('common.loading');
  }
  let text = filtered === total
    ? t('accounts.countTotal', { n: total })
    : t('accounts.countShowing', { shown: filtered, total });
  if (selCount) text += t('accounts.countSelected', { n: selCount });
  return text;
}

function getQuotaLeftNum(account) {
  const u = state.usageMap[account.id]?.data;
  if (!u) return -1;
  return getUsageMetrics(u).leftNum;
}

function getAccountExpirySortKey(account) {
  if (account.tokenExpiredAt) {
    const ts = Date.parse(account.tokenExpiredAt);
    if (!Number.isNaN(ts)) return ts;
  }
  return (account.tokenExp || 9999999999) * 1000;
}

export function filterAccounts(accounts) {
  let list = accounts;
  if (state.quotaFilter !== 'all') {
    list = list.filter((a) => {
      if (state.quotaFilter === 'expiring-soon') return a.tokenExpiringSoon && !a.tokenExpired;
      if (state.quotaFilter === 'expired') return a.tokenExpired;
      const status = getAccountQuotaStatus(a);
      if (state.quotaFilter === 'has-quota') return status === 'has-quota';
      if (state.quotaFilter === 'no-quota') return status === 'no-quota';
      return true;
    });
  }
  const q = state.accountSearch.trim().toLowerCase();
  if (q) {
    list = list.filter((a) =>
      [a.email, a.name, a.note, a.group].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }
  return sortAccounts(list);
}

export function sortAccounts(list) {
  const copy = [...list];
  switch (state.accountSort) {
    case 'quota-desc':
      return copy.sort((a, b) => getQuotaLeftNum(b) - getQuotaLeftNum(a));
    case 'quota-asc':
      return copy.sort((a, b) => getQuotaLeftNum(a) - getQuotaLeftNum(b));
    case 'name':
      return copy.sort((a, b) => (a.email || a.name || '').localeCompare(b.email || b.name || ''));
    case 'expiry':
      return copy.sort((a, b) => getAccountExpirySortKey(a) - getAccountExpirySortKey(b));
    default:
      return copy;
  }
}

function renderQuotaHtml(u) {
  if (u?.loading) return `<div class="quota-loading">${escapeHtml(t('common.loading'))}</div>`;
  if (u?.error) {
    return `<div class="quota-loading" style="color:var(--red)">${escapeHtml(u.error)}</div>`;
  }
  if (u?.data) {
    const m = getUsageMetrics(u.data);
    const color = m.exhausted || m.pct >= 80 ? 'var(--red)' : m.pct >= 50 ? 'var(--amber)' : 'var(--green)';
    return `<div class="quota-text"><span><strong>${m.usedText}</strong> / ${m.limitText}</span><span class="quota-left ${m.exhausted ? 'exhausted' : ''}">${m.leftText}</span></div><div class="quota-bar"><div class="quota-bar-fill" style="width:${m.pct}%;background:${color}"></div></div>`;
  }
  return '<div class="quota-loading">—</div>';
}

function renderCheckinTag(id) {
  const st = state.checkinState.results[id];
  if (!st) return '';
  if (st.status === 'checked' || st.status === 'already') {
    const points = st.points ? ` +${st.points}` : '';
    return `<span class="tag tag-checked">${escapeHtml(t('accounts.tagChecked'))}${escapeHtml(points)}</span>`;
  }
  if (st.status === 'rate') return `<span class="tag tag-warn">${escapeHtml(t('accounts.tagRate'))}</span>`;
  if (st.status === 'failed') return `<span class="tag tag-expired">${escapeHtml(t('accounts.tagCheckinFailed'))}</span>`;
  return '';
}

function renderAccountTags(a) {
  if (a.platform === 'workbuddy') {
    return [
      a.group ? `<span class="tag tag-group">${escapeHtml(a.group)}</span>` : '',
      renderCheckinTag(a.id),
    ].filter(Boolean).join('');
  }

  const u = state.usageMap[a.id];
  const status = getAccountQuotaStatus(a);
  return [
    a.edition === 'intl' ? `<span class="tag tag-intl">${escapeHtml(t('accounts.tagIntl'))}</span>` : '',
    a.group ? `<span class="tag tag-group">${escapeHtml(a.group)}</span>` : '',
    u?.data ? `<span class="tag tag-plan">${escapeHtml(u.data.planType || 'Free')}</span>` : '',
    a.isCurrent ? `<span class="tag tag-current">${escapeHtml(t('accounts.tagCurrent'))}</span>` : '',
    a.tokenExpired ? `<span class="tag tag-expired">${escapeHtml(t('accounts.tagExpired'))}</span>` : '',
    a.tokenExpiringSoon && !a.tokenExpired ? `<span class="tag tag-warn">${escapeHtml(t('accounts.tagExpiring'))}</span>` : '',
    status === 'has-quota' ? `<span class="tag tag-ok">${escapeHtml(t('accounts.tagOk'))}</span>` : '',
    status === 'no-quota' && !a.tokenExpired ? `<span class="tag tag-exhausted">${escapeHtml(t('accounts.tagExhausted'))}</span>` : '',
    renderCheckinTag(a.id),
  ].filter(Boolean).join('');
}

export function patchAccountCardUsage(id) {
  const account = state.allAccounts.find((a) => a.id === id);
  if (!account) return;
  const card = document.querySelector(`.account-card[data-id="${id}"]`);
  if (!card) return;
  const u = state.usageMap[id];
  const quotaEl = card.querySelector('.account-quota');
  const tagsEl = card.querySelector('.account-tags');
  if (quotaEl) quotaEl.innerHTML = renderQuotaHtml(u);
  if (tagsEl) tagsEl.innerHTML = renderAccountTags(account);
  const refreshBtn = card.querySelector('.btn-refresh-one');
  if (refreshBtn) {
    refreshBtn.disabled = !!u?.loading;
    refreshBtn.classList.toggle('is-loading', !!u?.loading);
  }
}

function renderAccountCard(a) {
  const u = state.usageMap[a.id];
  const isWb = a.platform === 'workbuddy';
  const hasEmail = !!(a.email && a.email.includes('@'));
  const title = isWb ? (a.name || `WorkBuddy ${String(a.wbUid || a.id).slice(0, 8)}`) : (hasEmail ? a.email : (a.name || `User ${a.id.slice(0, 8)}`));
  const sub = isWb
    ? [a.wbUid, a.wbEndpoint?.replace(/^https?:\/\//, '')].filter(Boolean).join(' · ')
    : [a.group, hasEmail && a.name && a.name !== a.email ? a.name : '', a.note].filter(Boolean).join(' · ');

  const quotaHtml = isWb ? '' : renderQuotaHtml(u);
  const tags = renderAccountTags(a);
  const checked = state.selectedIds.has(a.id) ? 'checked' : '';

  const wbActions = `
    <button class="btn-icon btn-detail" data-id="${a.id}" title="${escapeHtml(t('common.details'))}">⋯</button>
    <button class="btn-icon btn-checkin-one ${state.checkinLoadingIds.has(a.id) ? 'is-loading' : ''}" data-id="${a.id}" title="${escapeHtml(t('accounts.checkinOne'))}" ${state.checkinLoadingIds.has(a.id) ? 'disabled' : ''}>${state.checkinLoadingIds.has(a.id) ? '' : '✓'}</button>
    <button class="btn-icon btn-danger btn-remove" data-id="${a.id}" title="${escapeHtml(t('common.delete'))}">×</button>`;

  const traeActions = `
    <button class="btn-icon btn-detail" data-id="${a.id}" title="${escapeHtml(t('common.details'))}">⋯</button>
    <button class="btn-icon btn-refresh-one" data-id="${a.id}" title="${escapeHtml(t('common.refreshUsage'))}">↻</button>
    <button class="btn-icon btn-checkin-one ${state.checkinLoadingIds.has(a.id) ? 'is-loading' : ''}" data-id="${a.id}" title="${escapeHtml(t('accounts.checkinOne'))}" ${a.tokenExpired || state.checkinLoadingIds.has(a.id) ? 'disabled' : ''}>${state.checkinLoadingIds.has(a.id) ? '' : '✓'}</button>
    ${a.tokenExpired && a.hasCookies ? `<button class="btn btn-ghost btn-action btn-refresh-token" data-id="${a.id}">${escapeHtml(t('common.refresh'))}</button>` : ''}
    ${a.tokenExpired ? `<button class="btn btn-ghost btn-action btn-relogin" data-id="${a.id}">${escapeHtml(t('accounts.relogin'))}</button>` : ''}
    <div class="account-switch-btns">
      <button class="btn btn-primary btn-action btn-switch-account" data-id="${a.id}" ${a.isCurrent || (a.tokenExpired && !a.hasCookies) ? 'disabled' : ''} title="${escapeHtml(a.isCurrent ? t('accounts.switchTitleCurrent') : t('accounts.switchTitle'))}">${a.isCurrent ? escapeHtml(t('common.current')) : escapeHtml(t('common.switch'))}</button>
      <button class="btn btn-ghost btn-action btn-migrate-sessions" data-id="${a.id}" ${a.isCurrent ? 'disabled' : ''} title="${escapeHtml(a.isCurrent ? t('accounts.migrateTitleCurrent') : t('accounts.migrateTitle'))}">${escapeHtml(t('accounts.migrate'))}</button>
      <button class="btn btn-ghost btn-action btn-clean-switch" data-id="${a.id}" ${a.isCurrent || (a.tokenExpired && !a.hasCookies) ? 'disabled' : ''} title="${escapeHtml(a.isCurrent ? t('accounts.cleanSwitchTitleCurrent') : t('accounts.cleanSwitchTitle'))}">${escapeHtml(t('accounts.cleanSwitch'))}</button>
    </div>
    <button class="btn-icon btn-danger btn-remove" data-id="${a.id}" title="${escapeHtml(t('common.delete'))}">×</button>`;

  return `
    <div class="account-card ${a.isCurrent ? 'current' : ''} ${a.tokenExpired ? 'token-expired' : ''}" data-id="${a.id}">
      <label class="account-check"><input type="checkbox" class="account-select" data-id="${a.id}" ${checked} /></label>
      <div class="avatar">${a.avatarUrl ? `<img src="${escapeHtml(a.avatarUrl)}" alt="" />` : escapeHtml((title || '?').charAt(0).toUpperCase())}</div>
      <div class="account-main">
        <div class="account-head">
          <div class="account-head-text">
            <div class="account-title">${escapeHtml(title)}</div>
            ${sub ? `<div class="account-sub">${escapeHtml(sub)}</div>` : ''}
          </div>
          ${tags ? `<div class="account-tags">${tags}</div>` : ''}
        </div>
        ${quotaHtml ? `<div class="account-quota">${quotaHtml}</div>` : ''}
      </div>
      <div class="account-actions ${isWb ? 'workbuddy-actions' : ''}">
        ${isWb ? wbActions : traeActions}
      </div>
    </div>`;
}

function renderEditionGroup(label, list, edition) {
  return `
    <div class="account-group" data-edition="${edition}">
      <div class="account-group-title">${escapeHtml(label)}<span class="group-count">${list.length}</span></div>
      ${list.map(renderAccountCard).join('')}
    </div>`;
}

function renderPlatformGroup(platform, list) {
  const collapsed = !!state.platformCollapsed[platform];
  const icon = PLATFORM_ICONS[platform] || '';
  const name = t(`platform.${platform}`);
  const cnList = list.filter((a) => a.edition !== 'intl');
  const intlList = list.filter((a) => a.edition === 'intl');
  const hasEditionSplit = platform === 'trae' && cnList.length > 0 && intlList.length > 0;

  const body = collapsed ? '' : (hasEditionSplit
    ? renderEditionGroup(t('accounts.groupCN'), cnList, 'cn') + renderEditionGroup(t('accounts.groupIntl'), intlList, 'intl')
    : list.map(renderAccountCard).join(''));

  return `
    <div class="platform-group" data-platform="${platform}">
      <div class="platform-header">
        <span class="platform-toggle" data-platform="${platform}" aria-expanded="${!collapsed}">${collapsed ? '▶' : '▼'}</span>
        <span class="platform-icon">${icon}</span>
        <span class="platform-name">${escapeHtml(name)}</span>
        <span class="platform-count">${list.length}</span>
        <button class="btn btn-ghost btn-add-platform-account" data-platform="${platform}">${escapeHtml(t('platform.addAccount'))}</button>
      </div>
      <div class="platform-body ${collapsed ? 'collapsed' : ''}">${body}</div>
    </div>`;
}

function syncSelectAllCheckbox() {
  const visible = filterAccounts(state.allAccounts).map((a) => a.id);
  const allSelected = visible.length > 0 && visible.every((id) => state.selectedIds.has(id));
  const cb = $('#select-all-accounts');
  if (cb) cb.checked = allSelected;
}

function renderAccountListImpl() {
  setAccountsToolbarBusy(state.accountsSyncing);
  const filtered = filterAccounts(state.allAccounts);
  const selCount = state.selectedIds.size;
  const countEl = $('#filter-count');
  if (countEl) countEl.textContent = formatFilterCount(filtered.length, state.allAccounts.length, selCount);

  if (state.initialLoading || state.accountsSyncing) {
    accountList.innerHTML = accountsLoadingHtml(
      state.initialLoading ? t('overview.detecting') : state.accountsSyncMessage
    );
    return;
  }

  if (!state.allAccounts.length) {
    accountList.innerHTML = `<p class="empty">${escapeHtml(t('accounts.empty'))}</p>`;
    return;
  }
  if (!filtered.length) {
    accountList.innerHTML = `<p class="empty">${escapeHtml(t('accounts.emptyFilter'))}</p>`;
    return;
  }

  const byPlatform = {};
  for (const platform of PLATFORM_TYPES) byPlatform[platform] = [];
  for (const a of filtered) {
    const p = PLATFORM_TYPES.includes(a.platform) ? a.platform : 'trae';
    byPlatform[p].push(a);
  }

  const platformGroups = PLATFORM_TYPES.filter((p) => byPlatform[p].length > 0);
  if (platformGroups.length === 0) {
    accountList.innerHTML = `<p class="empty">${escapeHtml(t('accounts.emptyFilter'))}</p>`;
    return;
  }

  const html = platformGroups.map((platform) => renderPlatformGroup(platform, byPlatform[platform])).join('');
  const frag = htmlToFragment(html);
  accountList.textContent = '';
  accountList.appendChild(frag);
  syncSelectAllCheckbox();
}

export function renderAccountList() {
  renderAccountListRaf();
}

export async function loadUsageForAccount(id, { skipCache = false } = {}) {
  if (!skipCache) {
    const cached = state.usageCache.get(id);
    if (cached && Date.now() - cached.ts < state.usageCacheTtlMs) {
      state.usageMap[id] = { data: cached.data };
      return;
    }
  }
  try {
    const data = await unwrap(api.getAccountUsage(id));
    state.usageMap[id] = { data };
    state.usageCache.set(id, { data, ts: Date.now() });
  } catch (err) {
    // 444/429/过于频繁=服务端瞬时频控（迁移、切换、批量刷新后的冷却期），延迟重试一次避免错误固化在界面
    if (/444|429|过于频繁|频繁/.test(err.message)) {
      await new Promise((r) => setTimeout(r, 8000));
      try {
        const data = await unwrap(api.getAccountUsage(id));
        state.usageMap[id] = { data };
        state.usageCache.set(id, { data, ts: Date.now() });
        return;
      } catch {
        /* 落入下方错误显示 */
      }
    }
    state.usageMap[id] = { error: err.message };
  }
}

export async function refreshOneAccountUsage(id) {
  if (state.usageMap[id]?.loading) return;
  state.usageMap[id] = { loading: true };
  patchAccountCardUsage(id);
  await loadUsageForAccount(id, { skipCache: true });
  patchAccountCardUsage(id);
  state.lastRefreshTime = new Date();
  if (state.currentPage === 'overview') {
    const { updateOverview } = await import('./overview.js');
    updateOverview(state.allAccounts);
  }
}

export async function loadAllUsage(silent = false) {
  if (!state.allAccounts.length) return;
  if (!silent) {
    for (const a of state.allAccounts) state.usageMap[a.id] = { loading: true };
    renderAccountList();
  }
  await asyncPool(state.allAccounts, 5, (a) => loadUsageForAccount(a.id));
  state.lastRefreshTime = new Date();
  renderAccountList();
  updateOverview(state.allAccounts);
  const { updateAutoRefreshStatus } = await import('./settings.js');
  updateAutoRefreshStatus();
  await loadUsageHistory();
}

export async function loadCheckinState() {
  try {
    state.checkinState = await unwrap(api.getCheckinState());
  } catch {
    state.checkinState = { date: null, results: {} };
  }
}

export function scheduleRefreshAccounts() {
  clearTimeout(state.refreshDebounce);
  state.refreshDebounce = setTimeout(() => refreshAccounts(), 400);
}

function refreshExpiredTokensInBackground() {
  unwrap(api.refreshExpiredTokens())
    .then((result) => {
      if (result?.refreshed > 0) showToast(t('toast.autoRefreshTokens', { n: result.refreshed }));
      return result?.refreshed > 0 || result?.synced > 0 ? unwrap(api.listAccounts()) : null;
    })
    .then((accounts) => {
      if (accounts) {
        state.allAccounts = accounts;
        renderAccountList();
      }
    })
    .catch(() => { /* Token 刷新失败不阻塞界面 */ });
}

export async function refreshAccounts({ syncMessage = null } = {}) {
  const showSync = !!syncMessage;
  if (showSync) {
    state.accountsSyncing = true;
    state.accountsSyncMessage = syncMessage;
    renderAccountList();
  }
  try {
    let accounts = await unwrap(api.listAccounts());
    if (accounts.some((a) => !a.email)) {
      try { await unwrap(api.refreshProfiles()); accounts = await unwrap(api.listAccounts()); } catch { /* */ }
    }
    state.allAccounts = accounts;
    state.selectedIds = new Set([...state.selectedIds].filter((id) => accounts.some((a) => a.id === id)));
    await loadCheckinState();
    state.initialLoading = false;
    if (showSync) {
      state.accountsSyncing = false;
      state.accountsSyncMessage = '';
    }
    renderAccountList();
    refreshExpiredTokensInBackground();
    if (accounts.length) await loadAllUsage(true);
    renderAccountList();
  } catch (err) {
    state.initialLoading = false;
    state.accountsSyncing = false;
    state.accountsSyncMessage = '';
    renderAccountList();
    throw err;
  }
}

export function renderUI() {
  updateOverview(state.allAccounts);
  renderAccountList();
}
