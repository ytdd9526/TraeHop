import { api, unwrap } from '../core/api.js';
import { $, escapeHtml } from '../core/utils.js';
import { t, localeTag } from '../core/i18n.js';
import { showToast } from './common.js';

let configCache = null;
let statusTimer = null;
let lastStatus = null;

const PROV_LABEL = { trae: 'Trae', workbuddy: 'WorkBuddy' };

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('common.copied'));
  } catch {
    showToast(t('common.copyFailed'), true);
  }
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function fmtMs(ms) {
  const v = Number(ms) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

function fmtTime(sec) {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleString(localeTag(), {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function renderStatus(st) {
  lastStatus = st;
  const stateEl = $('#gw-state');
  if (stateEl) {
    stateEl.textContent = st.running ? t('gateway.stateRunning') : t('gateway.stateStopped');
    stateEl.className = `gw-state ${st.running ? 'gw-state-on' : 'gw-state-off'}`;
  }
  $('#gw-uptime').textContent = st.running ? t('gateway.port', { port: st.port }) : '—';
  $('#gw-base-url').textContent = st.baseUrl || t('gateway.startFirst');
  const keyEl = $('#gw-api-key');
  if (configCache?.apiKey) {
    keyEl.textContent = `${configCache.apiKey.slice(0, 10)}…${configCache.apiKey.slice(-4)}`;
    keyEl.title = configCache.apiKey;
  } else {
    keyEl.textContent = '—';
  }
  $('#btn-gateway-toggle').textContent = st.running ? t('gateway.stop') : t('gateway.start');
  $('#btn-gateway-toggle').disabled = false;
  $('#btn-gateway-restart').disabled = !st.running;

  const provList = $('#gw-prov-list');
  if (provList) {
    provList.innerHTML = Object.entries(st.providers || {}).map(([name, p]) => `
      <div class="gw-prov-item">
        <div class="gw-prov-head">
          <span class="gw-prov-name">${escapeHtml(PROV_LABEL[name] || name)}</span>
          <label class="toggle-row toggle-row-sm">
            <input type="checkbox" data-prov-toggle="${escapeHtml(name)}" ${p.enabled ? 'checked' : ''} />
            <span class="toggle"></span>
          </label>
        </div>
        <div class="gw-prov-meta">
          <span class="${p.accounts > 0 ? 'gw-ok-text' : 'gw-bad-text'}">
            ${t('gateway.provAccounts', { count: p.accounts })}
          </span>
        </div>
      </div>
    `).join('');
  }

  renderTunnel(st.tunnel || {});
}

function renderTunnel(tn) {
  const stateEl = $('#gw-tunnel-state');
  const urlEl = $('#gw-tunnel-url');
  const btn = $('#btn-gw-tunnel-toggle');
  if (!stateEl) return;
  const map = {
    off: { key: 'gateway.tunnelOff', cls: 'gw-state-off' },
    starting: { key: 'gateway.tunnelStarting', cls: 'gw-state-warn' },
    up: { key: 'gateway.tunnelUp', cls: 'gw-state-on' },
    error: { key: 'gateway.tunnelError', cls: 'gw-state-bad' },
  };
  const m = map[tn.state] || map.off;
  stateEl.textContent = t(m.key);
  stateEl.className = `gw-state ${m.cls}`;
  urlEl.textContent = tn.publicURL || (tn.errMsg ? tn.errMsg : '—');
  urlEl.title = tn.publicURL || '';
  btn.textContent = tn.state === 'up' || tn.state === 'starting' ? t('gateway.tunnelDisable') : t('gateway.tunnelEnable');
}

async function refreshStatus() {
  try {
    const st = await unwrap(api.gateway.getStatus());
    renderStatus(st);
  } catch { /* 静默 */ }
}

async function loadConfigForm() {
  const cfg = await unwrap(api.gateway.getConfig());
  configCache = cfg;
  $('#gw-host').value = cfg.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  $('#gw-port').value = cfg.port;
  $('#gw-default-provider').value = cfg.defaultProvider || 'trae';
  $('#gw-max-rotate').value = cfg.maxRotate || 6;
  $('#gw-connect-timeout').value = cfg.connectTimeoutSec || 15;
  $('#gw-auto-start').checked = !!cfg.autoStart;
  $('#gw-expose-prefix').checked = !!cfg.exposePrefixModels;
  $('#gw-auto-checkin').checked = !!cfg.autoCheckin;
}

async function collectConfigForm() {
  return {
    host: $('#gw-host').value,
    port: Number($('#gw-port').value) || 8690,
    defaultProvider: $('#gw-default-provider').value,
    maxRotate: Number($('#gw-max-rotate').value) || 6,
    connectTimeoutSec: Number($('#gw-connect-timeout').value) || 15,
    autoStart: $('#gw-auto-start').checked,
    exposePrefixModels: $('#gw-expose-prefix').checked,
    autoCheckin: $('#gw-auto-checkin').checked,
    providers: { ...configCache?.providers },
  };
}

function provCellHtml(provName, p) {
  const label = PROV_LABEL[provName] || provName;
  return `
    <div class="gw-share-prov" data-prov="${escapeHtml(provName)}">
      <label class="toggle-row toggle-row-sm">
        <span>${escapeHtml(label)}</span>
        <input type="checkbox" class="gw-share-prov-enabled" ${p.enabled ? 'checked' : ''} />
        <span class="toggle"></span>
      </label>
      <div class="gw-share-prov-fields">
        <label class="gw-share-field">
          <span>${t('gateway.shareLimit')}</span>
          <input type="number" class="gw-share-limit text-input" min="0" value="${p.limit || 0}" placeholder="0" />
        </label>
        <label class="gw-share-field gw-share-field-wide">
          <span>${t('gateway.shareModels')}</span>
          <input type="text" class="gw-share-models text-input" value="${escapeHtml((p.models || []).join(', '))}" placeholder="${t('gateway.shareModelsPlaceholder')}" />
        </label>
      </div>
      <div class="gw-share-used">
        ${t('gateway.shareUsed', { tokens: fmtTokens(p.usedTokens), reqs: p.usedReqs })}
      </div>
    </div>
  `;
}

async function loadShares() {
  const list = await unwrap(api.gateway.getShares());
  const box = $('#gw-shares-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p class="muted gw-empty">${t('gateway.shareEmpty')}</p>`;
    return;
  }
  box.innerHTML = list.map((s) => `
    <div class="gw-share-card" data-id="${escapeHtml(s.id)}">
      <div class="gw-share-head">
        <input type="text" class="gw-share-name text-input" value="${escapeHtml(s.name)}" maxlength="40" />
        <span class="gw-share-date">${t('gateway.shareCreatedTime', { time: fmtTime(s.createdAt) })}</span>
        <label class="toggle-row toggle-row-sm">
          <input type="checkbox" class="gw-share-enabled" ${s.enabled ? 'checked' : ''} />
          <span class="toggle"></span>
        </label>
        <button type="button" class="btn btn-ghost btn-danger-text gw-share-del">${t('gateway.shareDelete')}</button>
      </div>
      <div class="gw-copy-row">
        <code class="gw-share-key">${escapeHtml(s.key)}</code>
        <button type="button" class="btn btn-ghost btn-copy gw-share-copy">${t('common.copy')}</button>
      </div>
      <div class="gw-share-provs">
        ${Object.entries(s.providers || {}).map(([n, p]) => provCellHtml(n, p)).join('')}
      </div>
    </div>
  `).join('');
}

async function loadUsage() {
  const list = await unwrap(api.gateway.getUsageLog(100));
  const box = $('#gw-usage-table');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p class="muted gw-empty">${t('gateway.usageEmpty')}</p>`;
    return;
  }
  const rows = list.map((e) => `
    <div class="gw-usage-row ${e.ok ? '' : 'gw-usage-bad'}">
      <span class="gw-usage-time">${fmtTime(e.time)}</span>
      <span class="gw-usage-caller" title="${escapeHtml(e.caller)}">${escapeHtml(e.caller || t('gateway.usageOwner'))}</span>
      <span class="gw-usage-prov">${escapeHtml(PROV_LABEL[e.provider] || e.provider)}</span>
      <span class="gw-usage-model" title="${escapeHtml(e.model)}">${escapeHtml(e.model)}</span>
      <span class="gw-usage-tokens">${fmtTokens(e.totalTokens)}</span>
      <span class="gw-usage-dur">${fmtMs(e.durationMs)}</span>
      <span class="gw-usage-status">${e.ok ? 'OK' : escapeHtml(e.errMsg || 'ERR')}</span>
    </div>
  `).join('');
  box.innerHTML = `
    <div class="gw-usage-row gw-usage-head">
      <span>${t('gateway.usageTime')}</span>
      <span>${t('gateway.usageCaller')}</span>
      <span>${t('gateway.usageProv')}</span>
      <span>${t('gateway.usageModel')}</span>
      <span>${t('gateway.usageTokens')}</span>
      <span>${t('gateway.usageDur')}</span>
      <span>${t('gateway.usageStatus')}</span>
    </div>
    ${rows}
  `;
}

export async function loadGatewayPage() {
  await loadConfigForm();
  await refreshStatus();
  await Promise.allSettled([loadShares(), loadUsage()]);
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    if ($('#page-gateway')?.classList.contains('active')) refreshStatus();
  }, 5000);
}

async function saveSettings() {
  const btn = $('#btn-gw-save');
  btn.disabled = true;
  try {
    const partial = await collectConfigForm();
    const res = await unwrap(api.gateway.saveConfig(partial));
    configCache = res.config;
    showToast(res.restarted ? t('gateway.savedRestarted') : t('gateway.saved'));
    await refreshStatus();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function toggleGateway() {
  const btn = $('#btn-gateway-toggle');
  btn.disabled = true;
  try {
    const running = lastStatus?.running;
    const st = running ? await unwrap(api.gateway.stop()) : await unwrap(api.gateway.start());
    renderStatus(st);
  } catch (err) {
    showToast(err.message, true);
    btn.disabled = false;
  }
}

async function restartGateway() {
  const btn = $('#btn-gateway-restart');
  btn.disabled = true;
  try {
    const st = await unwrap(api.gateway.restart());
    renderStatus(st);
    showToast(t('gateway.restarted'));
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function resetKey() {
  const key = await unwrap(api.gateway.resetKey());
  if (configCache) configCache.apiKey = key;
  showToast(t('gateway.keyReset'));
  refreshStatus();
}

async function toggleTunnel() {
  const btn = $('#btn-gw-tunnel-toggle');
  btn.disabled = true;
  try {
    const tn = (await unwrap(api.gateway.tunnelStatus()));
    const st = tn.state === 'up' || tn.state === 'starting'
      ? await unwrap(api.gateway.stopTunnel())
      : await unwrap(api.gateway.startTunnel());
    renderTunnel(st);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function patchShare(id, patch) {
  try {
    await unwrap(api.gateway.updateShare(id, patch));
  } catch (err) {
    showToast(err.message, true);
    await loadShares();
  }
}

function parseModels(text) {
  return String(text || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bindShareCardEvents() {
  const box = $('#gw-shares-list');
  if (!box) return;

  box.addEventListener('click', async (e) => {
    const card = e.target.closest('.gw-share-card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('.gw-share-del')) {
      try {
        await unwrap(api.gateway.removeShare(id));
        showToast(t('gateway.shareRemoved'));
        loadShares();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }
    if (e.target.closest('.gw-share-copy')) {
      const key = card.querySelector('.gw-share-key')?.textContent || '';
      copyText(key);
    }
  });

  box.addEventListener('change', (e) => {
    const card = e.target.closest('.gw-share-card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.classList.contains('gw-share-enabled')) {
      patchShare(id, { enabled: e.target.checked });
      return;
    }
    if (e.target.classList.contains('gw-share-prov-enabled')) {
      const prov = e.target.closest('.gw-share-prov')?.dataset.prov;
      if (prov) patchShare(id, { providers: { [prov]: { enabled: e.target.checked } } });
    }
  });

  box.addEventListener('focusout', (e) => {
    const card = e.target.closest('.gw-share-card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.classList.contains('gw-share-name')) {
      const name = e.target.value.trim();
      if (name) patchShare(id, { name });
      return;
    }
    if (e.target.classList.contains('gw-share-limit')) {
      const prov = e.target.closest('.gw-share-prov')?.dataset.prov;
      if (prov) patchShare(id, { providers: { [prov]: { limit: Number(e.target.value) || 0 } } });
      return;
    }
    if (e.target.classList.contains('gw-share-models')) {
      const prov = e.target.closest('.gw-share-prov')?.dataset.prov;
      if (prov) patchShare(id, { providers: { [prov]: { models: parseModels(e.target.value) } } });
    }
  });
}

async function createShare() {
  const btn = $('#btn-gw-share-add');
  btn.disabled = true;
  try {
    const existing = await unwrap(api.gateway.getShares());
    const name = `${t('gateway.shareDefaultName')} ${existing.length + 1}`;
    await unwrap(api.gateway.createShare(name, {
      trae: { enabled: true },
      workbuddy: { enabled: false },
    }));
    showToast(t('gateway.shareCreated'));
    await loadShares();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

export function initGatewayEvents() {
  $('#btn-gateway-toggle')?.addEventListener('click', toggleGateway);
  $('#btn-gateway-restart')?.addEventListener('click', restartGateway);
  $('#btn-gw-save')?.addEventListener('click', saveSettings);
  $('#btn-gw-reset-key')?.addEventListener('click', resetKey);
  $('#btn-gw-tunnel-toggle')?.addEventListener('click', toggleTunnel);
  $('#btn-gw-share-add')?.addEventListener('click', createShare);
  $('#btn-gw-usage-refresh')?.addEventListener('click', () => loadUsage().catch((e) => showToast(e.message, true)));
  bindShareCardEvents();

  $('#page-gateway')?.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (!copyBtn) return;
    const el = $(`#${copyBtn.dataset.copy}`);
    const text = el?.title || el?.textContent || '';
    if (text && text !== '—' && text !== t('gateway.startFirst')) copyText(text);
  });

  $('#gw-prov-list')?.addEventListener('change', async (e) => {
    const name = e.target.dataset.provToggle;
    if (!name || !configCache) return;
    const providers = { ...configCache.providers };
    providers[name] = { ...(providers[name] || {}), enabled: e.target.checked };
    try {
      const res = await unwrap(api.gateway.saveConfig({ providers }));
      configCache = res.config;
      showToast(t('gateway.saved'));
      refreshStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
