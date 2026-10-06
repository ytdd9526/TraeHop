import { state } from '../core/state.js';
import { $, escapeHtml } from '../core/utils.js';

export function showToast(msg, isError = false) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

export function accountsLoadingHtml(message) {
  return `<div class="page-loading page-loading-inline"><div class="loading-spinner" aria-hidden="true"></div><p class="loading-text">${escapeHtml(message)}</p></div>`;
}

export function setAccountsToolbarBusy(busy) {
  ['#btn-export-accounts', '#btn-import-file', '#btn-import-trae-cn', '#btn-import-trae-intl', '#btn-refresh-usage', '#btn-add'].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = busy;
  });
}
