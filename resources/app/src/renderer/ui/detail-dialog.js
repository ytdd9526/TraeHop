import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $ } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts } from './accounts.js';

const detailDialog = $('#account-detail-dialog');

export async function openDetailDialog(id) {
  const a = state.allAccounts.find((x) => x.id === id);
  if (!a) return;
  $('#detail-account-id').value = id;
  $('#detail-group').value = a.group || '';
  $('#detail-note').value = a.note || '';
  $('#detail-machine-id').textContent = a.machineId || t('common.notBound');
  detailDialog.showModal();
}

export function initDetailDialogEvents() {
  $('#btn-detail-cancel').addEventListener('click', () => detailDialog.close());
  $('#btn-detail-close').addEventListener('click', () => detailDialog.close());
  $('#btn-detail-save').addEventListener('click', async () => {
    const id = $('#detail-account-id').value;
    try {
      await unwrap(api.updateAccountMeta(id, {
        group: $('#detail-group').value,
        note: $('#detail-note').value,
      }));
      detailDialog.close();
      showToast(t('toast.saved'));
      await refreshAccounts();
    } catch (err) { showToast(err.message, true); }
  });

  $('#btn-bind-machine').addEventListener('click', async () => {
    const id = $('#detail-account-id').value;
    try {
      const r = await unwrap(api.bindMachineId(id));
      $('#detail-machine-id').textContent = r.machineId;
      showToast(t('toast.bound'));
      await refreshAccounts();
    } catch (err) { showToast(err.message, true); }
  });

  $('#btn-regen-machine').addEventListener('click', async () => {
    const id = $('#detail-account-id').value;
    if (!confirm(t('detailDialog.regenConfirm'))) return;
    try {
      const r = await unwrap(api.regenerateMachineId(id));
      $('#detail-machine-id').textContent = r.machineId;
      showToast(t('toast.regenerated'));
      await refreshAccounts();
    } catch (err) { showToast(err.message, true); }
  });
}
