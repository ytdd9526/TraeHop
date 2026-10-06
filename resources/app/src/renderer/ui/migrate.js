import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $, accountLabel, appendDialogLog } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts } from './accounts.js';

const migrateDialog = $('#migrate-dialog');

export function openMigrateDialog(id) {
  const target = state.allAccounts.find((a) => a.id === id);
  const current = state.allAccounts.find((a) => a.isCurrent);
  $('#migrate-summary').textContent = t('migrateDialog.summary', {
    from: accountLabel(current),
    to: accountLabel(target),
  });
  $('#migrate-log').textContent = '';
  const btn = $('#btn-migrate-confirm');
  btn.disabled = false;
  btn.textContent = t('migrateDialog.start');
  migrateDialog.dataset.targetId = id;
  migrateDialog.showModal();
}

export async function runMigrateFlow() {
  if (state.migrateRunning) return;
  state.migrateRunning = true;
  const btn = $('#btn-migrate-confirm');
  btn.disabled = true;
  btn.textContent = t('migrateDialog.running');
  $('#migrate-log').textContent = '';
  const unsub = api.onMigrateLog((msg) => appendDialogLog('#migrate-log', msg));
  try {
    const result = await unwrap(api.migrateSessions(migrateDialog.dataset.targetId));
    $('#migrate-summary').textContent = t('migrateDialog.doneSummary', {
      migrated: result.migrated,
      native: result.native,
      sessions: result.sessions,
    });
    appendDialogLog('#migrate-log', t('migrateDialog.rateNotice'));
    showToast(t('toast.migrateDone', { migrated: result.migrated }));
    await refreshAccounts();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    unsub();
    state.migrateRunning = false;
    btn.disabled = false;
    btn.textContent = t('migrateDialog.start');
  }
}

export function initMigrateEvents() {
  $('#btn-migrate-confirm').addEventListener('click', runMigrateFlow);
  $('#btn-migrate-cancel').addEventListener('click', () => { if (!state.migrateRunning) migrateDialog.close(); });
  $('#btn-migrate-close').addEventListener('click', () => { if (!state.migrateRunning) migrateDialog.close(); });
  migrateDialog.addEventListener('cancel', (e) => { if (state.migrateRunning) e.preventDefault(); });
  migrateDialog.addEventListener('click', (e) => { if (state.migrateRunning && e.target === migrateDialog) e.preventDefault(); });
}
