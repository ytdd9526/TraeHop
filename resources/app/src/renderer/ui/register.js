import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $, appendDialogLog } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts } from './accounts.js';

const registerDialog = $('#register-dialog');

export function openRegisterDialog() {
  if (state.registerRunning) return;
  $('#register-log').textContent = '';
  const btn = $('#btn-register-confirm');
  btn.disabled = false;
  btn.textContent = t('registerDialog.start');
  registerDialog.showModal();
}

export async function runRegisterFlow() {
  if (state.registerRunning) return;
  state.registerRunning = true;
  const btn = $('#btn-register-confirm');
  btn.disabled = true;
  btn.textContent = t('registerDialog.running');
  $('#register-log').textContent = '';
  const unsub = api.onRegisterLog((msg) => appendDialogLog('#register-log', msg));
  try {
    const opts = {
      total: Math.max(1, Math.min(20, Number($('#register-total').value) || 1)),
      concurrency: Math.max(1, Math.min(3, Number($('#register-concurrency').value) || 1)),
      pace: $('#register-pace').value === 'fast' ? 'fast' : 'steady',
      claimGift: $('#register-gift').checked,
      proxies: $('#register-proxies').value.split('\n').map((l) => l.trim()).filter(Boolean),
    };
    const result = await unwrap(api.runRegister(opts));
    showToast(t('registerDialog.doneToast', { ok: result?.success || 0, fail: result?.fail || 0 }), (result?.fail || 0) > 0);
    refreshAccounts();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    unsub();
    state.registerRunning = false;
    btn.disabled = false;
    btn.textContent = t('registerDialog.start');
  }
}

export function initRegisterEvents() {
  $('#btn-open-register').addEventListener('click', openRegisterDialog);
  $('#btn-register-confirm').addEventListener('click', runRegisterFlow);
  $('#btn-register-cancel').addEventListener('click', () => { if (!state.registerRunning) { registerDialog.close(); api.cancelRegister().catch(() => {}); } else { api.cancelRegister().catch(() => {}); } });
  $('#btn-register-close').addEventListener('click', () => { if (!state.registerRunning) registerDialog.close(); else api.cancelRegister().catch(() => {}); });
  registerDialog.addEventListener('cancel', (e) => { if (state.registerRunning) e.preventDefault(); });
}
