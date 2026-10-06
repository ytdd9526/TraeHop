import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $, escapeHtml, shortenPath } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts } from './accounts.js';

export function setCleanRunning(running) {
  state.cleanCleaning = running;
  $('#btn-start-clean').disabled = running;
  $('#btn-start-clean').textContent = running ? t('clean.cleaning') : t('clean.start');
  $('#btn-cancel-clean').classList.toggle('hidden', !running);
  $('#btn-rescan-clean').disabled = running;
}

export async function scanCleanSize() {
  const sizeEl = $('#clean-scan-size');
  const itemsEl = $('#clean-scan-items');
  const platformEl = $('#clean-platform');
  sizeEl.textContent = t('common.scanning');
  itemsEl.innerHTML = '';
  platformEl.textContent = '';
  try {
    const data = await unwrap(api.scanClean());
    sizeEl.textContent = data.formatted;
    platformEl.textContent = data.platform || '';
    if (data.items?.length) {
      itemsEl.innerHTML = data.items.slice(0, 5).map((item) =>
        `<li><span class="clean-item-path" title="${escapeHtml(item.path)}">${escapeHtml(shortenPath(item.path))}</span><span class="clean-item-size">${escapeHtml(item.formatted)}</span></li>`
      ).join('');
      if (data.items.length > 5) itemsEl.innerHTML += `<li class="clean-item-more">${escapeHtml(t('clean.moreItems', { n: data.items.length - 5 }))}</li>`;
    }
    state.cleanScanned = true;
  } catch (err) {
    sizeEl.textContent = t('common.scanFailed');
    showToast(err.message, true);
  }
}

function appendCleanLog(msg) {
  const el = $('#clean-log');
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

export async function handleClean() {
  if (state.cleanCleaning) return;
  if (!confirm(`${t('common.advanced')}\n\n${t('clean.confirmBody')}\n\n${t('common.continue')}`)) return;
  setCleanRunning(true);
  $('#clean-log').textContent = '';
  const unsub = api.onCleanLog(appendCleanLog);
  const res = await api.startClean();
  unsub();
  setCleanRunning(false);
  state.cleanScanned = false;
  if (res.ok && res.data?.success) {
    showToast(t('clean.done', { size: res.data.formatted }));
    await scanCleanSize();
    await refreshAccounts();
  } else if (res.ok && res.data && !res.data.success) {
    showToast(t('clean.cancelled'));
    await scanCleanSize();
  } else if (!res.ok) {
    appendCleanLog(t('clean.errorLog', { msg: res.error }));
    showToast(res.error, true);
  }
}

export function initCleanEvents() {
  $('#btn-rescan-clean').addEventListener('click', () => { state.cleanScanned = false; scanCleanSize(); });
  $('#btn-start-clean').addEventListener('click', handleClean);
  $('#btn-cancel-clean').addEventListener('click', () => api.cancelClean());
}
