import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $ } from '../core/utils.js';
import { appendDialogLog } from '../core/utils.js';
import { showToast } from './common.js';
import { loadCheckinState, renderAccountList } from './accounts.js';

const checkinDialog = $('#checkin-dialog');

export function openCheckinDialog() {
  $('#checkin-log').textContent = '';
  const summary = $('#checkin-summary');
  summary.textContent = t('checkinDialog.idleHint');
  loadCheckinState().then(() => {
    const entries = Object.values(state.checkinState?.results || {});
    if (entries.length) {
      const counts = {};
      for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
      summary.textContent = t('checkinDialog.stateSummary', {
        date: state.checkinState.date,
        checked: counts.checked || 0,
        already: counts.already || 0,
        failed: counts.failed || 0,
      });
    }
  }).catch(() => {});
  const btn = $('#btn-checkin-confirm');
  btn.disabled = false;
  btn.textContent = t('checkinDialog.start');
  checkinDialog.showModal();
}

export async function runCheckinFlow() {
  if (state.checkinRunning) return;
  state.checkinRunning = true;
  const btn = $('#btn-checkin-confirm');
  btn.disabled = true;
  btn.textContent = t('checkinDialog.running');
  $('#checkin-log').textContent = '';
  const unsub = api.onCheckinLog((msg) => appendDialogLog('#checkin-log', msg));
  try {
    const result = await unwrap(api.runCheckin());
    const counts = {};
    for (const r of result.results) counts[r.status] = (counts[r.status] || 0) + 1;
    const checked = counts.checked || 0;
    const already = counts.already || 0;
    const failed = counts.failed || 0;
    $('#checkin-summary').textContent = t('checkinDialog.doneSummary', { checked, already, failed });
    showToast(t('toast.checkinDone', { checked, failed }), failed > 0);
    await loadCheckinState();
    renderAccountList();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    unsub();
    state.checkinRunning = false;
    btn.disabled = false;
    btn.textContent = t('checkinDialog.start');
  }
}

export function initCheckinEvents() {
  $('#btn-checkin').addEventListener('click', openCheckinDialog);
  $('#btn-checkin-confirm').addEventListener('click', runCheckinFlow);
  $('#btn-checkin-cancel').addEventListener('click', () => checkinDialog.close());
  $('#btn-checkin-close').addEventListener('click', () => checkinDialog.close());
}
