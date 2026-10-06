import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t, listSep } from '../core/i18n.js';
import { $, escapeHtml } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts } from './accounts.js';

const machinePanelEl = $('#machine-panel');

function machineBoundAccounts(machineId) {
  if (!machineId) return [];
  return state.allAccounts.filter((a) => a.machineId === machineId).map((a) => a.email || a.name);
}

function renderMachineRow(info) {
  const editionLabel = t(info.edition === 'intl' ? 'accounts.groupIntl' : 'accounts.groupCN');
  const bound = machineBoundAccounts(info.machineId);
  const headMeta = !info.installed
    ? `<span class="machine-meta machine-meta-muted">${escapeHtml(t('machinePanel.notInstalled'))}</span>`
    : info.hasLogin
      ? `<span class="machine-meta">${escapeHtml(info.loggedInEmail ? t('machinePanel.loggedIn', { email: info.loggedInEmail }) : t('machinePanel.loggedInPlain'))}</span>`
      : `<span class="machine-meta machine-meta-muted">${escapeHtml(t('machinePanel.notLoggedIn'))}</span>`;

  return `
    <div class="machine-row" data-edition="${info.edition}" data-machine-id="${escapeHtml(info.machineId || '')}">
      <div class="machine-row-head">
        <span class="machine-edition">${escapeHtml(editionLabel)}</span>
        ${headMeta}
      </div>
      <div class="machine-field">
        <span class="machine-field-label">machineid</span>
        <code class="machine-field-value">${escapeHtml(info.machineId || t('machinePanel.noMachineId'))}</code>
        <button type="button" class="btn btn-ghost machine-btn" data-action="copy" ${info.machineId ? '' : 'disabled'}>${escapeHtml(t('machinePanel.copy'))}</button>
      </div>
      <div class="machine-field">
        <span class="machine-field-label">telemetry.machineId</span>
        <code class="machine-field-value">${escapeHtml(info.telemetryMachineId || t('machinePanel.noMachineId'))}</code>
      </div>
      <div class="machine-field">
        <span class="machine-field-label">${escapeHtml(t('machinePanel.boundAccounts'))}</span>
        <span class="machine-bound-list">${bound.length ? bound.map(escapeHtml).join(listSep()) : escapeHtml(t('machinePanel.noBoundAccounts'))}</span>
      </div>
      <div class="machine-actions">
        <button type="button" class="btn btn-ghost btn-danger-text machine-btn" data-action="reset" ${info.installed ? '' : 'disabled'}>${escapeHtml(t('machinePanel.reset'))}</button>
        <button type="button" class="btn btn-ghost btn-danger-text machine-btn" data-action="clear-login" ${info.installed ? '' : 'disabled'}>${escapeHtml(t('machinePanel.clearLogin'))}</button>
      </div>
    </div>`;
}

export function renderMachinePanel(list) {
  if (machinePanelEl) machinePanelEl.innerHTML = (list || []).map(renderMachineRow).join('');
}

export async function loadMachinePanel() {
  try {
    state.machineInfoCache = await unwrap(api.getMachineInfo());
    renderMachinePanel(state.machineInfoCache);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function copyMachineIdToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('machinePanel.copied'));
  } catch {
    showToast(t('machinePanel.copyFailed'), true);
  }
}

export function initMachineEvents() {
  machinePanelEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const row = btn.closest('.machine-row');
    if (!row) return;
    const edition = row.dataset.edition;
    const editionLabel = t(edition === 'intl' ? 'accounts.groupIntl' : 'accounts.groupCN');

    if (btn.dataset.action === 'copy') {
      await copyMachineIdToClipboard(row.dataset.machineId);
      return;
    }

    if (btn.dataset.action === 'reset') {
      if (!confirm(t('machinePanel.resetConfirm', { edition: editionLabel }))) return;
      btn.disabled = true;
      try {
        const r = await unwrap(api.resetMachineId(edition));
        showToast(t('machinePanel.resetDone', { edition: editionLabel, id: r.machineId }));
      } catch (err) {
        showToast(err.message, true);
      }
      await loadMachinePanel();
      return;
    }

    if (btn.dataset.action === 'clear-login') {
      if (!confirm(t('machinePanel.clearConfirm', { edition: editionLabel }))) return;
      btn.disabled = true;
      try {
        await unwrap(api.clearLoginState(edition));
        showToast(t('machinePanel.clearDone', { edition: editionLabel }));
      } catch (err) {
        showToast(err.message, true);
      }
      await loadMachinePanel();
      await refreshAccounts();
    }
  });
}
