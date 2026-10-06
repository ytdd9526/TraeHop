import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t, listSep } from '../core/i18n.js';
import { $, escapeHtml } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts } from './accounts.js';
import { switchPage } from './navigation.js';

const exportDialog = $('#export-dialog');
const importDialog = $('#import-dialog');
const editionPickDialog = $('#edition-pick-dialog');

export function openExportDialog() {
  const ids = state.selectedIds.size ? [...state.selectedIds] : state.allAccounts.map((a) => a.id);
  exportDialog.dataset.ids = JSON.stringify(ids);
  $('#export-count-hint').textContent = t('exportDialog.hint', { n: ids.length });
  $('#export-encrypt').checked = false;
  $('#export-password').value = '';
  $('#export-password-wrap').classList.add('hidden');
  exportDialog.showModal();
}

function resetImportDialog() {
  state.importPending = null;
  $('#import-mode').value = 'skip';
  $('#import-password').value = '';
  $('#import-password-wrap').classList.add('hidden');
  const fileHint = $('#import-file-hint');
  fileHint.textContent = '';
  fileHint.classList.add('hidden');
  $('#btn-import-confirm').textContent = t('importDialog.pickFile');
}

export function openImportDialog() {
  resetImportDialog();
  importDialog.showModal();
}

async function finishImport(content, mode, password) {
  const btn = $('#btn-import-confirm');
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('importDialog.importing');
  try {
    const result = await unwrap(api.importAccountsContent({ content, mode, password }));
    if (!result) return;
    const parts = [];
    if (result.imported) parts.push(t('toast.importAdded', { n: result.imported }));
    if (result.updated) parts.push(t('toast.importUpdated', { n: result.updated }));
    if (result.skipped) parts.push(t('toast.importSkipped', { n: result.skipped }));
    importDialog.close();
    resetImportDialog();
    switchPage('accounts');
    showToast(parts.length ? parts.join(listSep()) : t('toast.importNone'), !result.imported && !result.updated);
    await refreshAccounts({ syncMessage: t('sync.importedSync') });
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

async function importTraeWithEdition(edition) {
  const result = await unwrap(api.importFromTrae(edition));
  showToast(t('toast.imported', {
    edition: t(edition === 'intl' ? 'accounts.groupIntl' : 'accounts.groupCN'),
    email: result.account.email || result.account.name,
  }));
  await refreshAccounts({ syncMessage: t('sync.importing') });
}

function openEditionPickDialog(sessions) {
  const fill = (sel, session) => {
    const btn = $(sel);
    const who = session.email || session.name || '';
    btn.innerHTML = `${escapeHtml(t(session.edition === 'intl' ? 'accounts.groupIntl' : 'accounts.groupCN'))}` +
      (who ? `<span class="pick-sub">${escapeHtml(who)}</span>` : '');
    btn.dataset.edition = session.edition;
  };
  fill('#btn-pick-cn', sessions.find((s) => s.edition === 'cn'));
  fill('#btn-pick-intl', sessions.find((s) => s.edition === 'intl'));
  editionPickDialog.showModal();
}

export async function startTraeImport() {
  const sessions = await unwrap(api.listTraeSessions());
  if (!sessions.length) {
    showToast(t('importDialog.noSession'), true);
    return false;
  }
  if (sessions.length === 1) {
    await importTraeWithEdition(sessions[0].edition);
    return true;
  }
  openEditionPickDialog(sessions);
  return false;
}

async function startTraeImportFor(edition) {
  const sessions = await unwrap(api.listTraeSessions());
  if (!sessions.some((s) => s.edition === edition)) {
    showToast(t(edition === 'intl' ? 'importDialog.noSessionIntl' : 'importDialog.noSessionCn'), true);
    return false;
  }
  await importTraeWithEdition(edition);
  return true;
}

export async function withImportBusy(btn, action) {
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = t('importDialog.importing');
  try {
    await action();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

async function handleEditionPick(btn) {
  const edition = btn.dataset.edition;
  const cnBtn = $('#btn-pick-cn');
  const intlBtn = $('#btn-pick-intl');
  cnBtn.disabled = true;
  intlBtn.disabled = true;
  btn.textContent = t('importDialog.importing');
  try {
    await importTraeWithEdition(edition);
    editionPickDialog.close();
    if ($('#add-dialog').open) {
      const { closeAddDialog } = await import('./add-account.js');
      await closeAddDialog();
      switchPage('accounts');
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    cnBtn.disabled = false;
    intlBtn.disabled = false;
  }
}

export function initImportExportEvents() {
  $('#btn-export-accounts').addEventListener('click', openExportDialog);
  $('#btn-import-file').addEventListener('click', openImportDialog);

  $('#export-encrypt').addEventListener('change', (e) => {
    $('#export-password-wrap').classList.toggle('hidden', !e.target.checked);
  });

  $('#btn-export-cancel').addEventListener('click', () => exportDialog.close());
  $('#btn-export-close').addEventListener('click', () => exportDialog.close());
  $('#btn-export-confirm').addEventListener('click', async () => {
    const ids = JSON.parse(exportDialog.dataset.ids || '[]');
    const encrypt = $('#export-encrypt').checked;
    const password = $('#export-password').value;
    if (encrypt && password.length < 6) { showToast(t('toast.passwordMin6'), true); return; }
    try {
      const result = await unwrap(api.exportAccounts({ ids, password: encrypt ? password : '' }));
      if (result) showToast(t('toast.exported', { n: result.count }) + (result.encrypted ? t('toast.exportedEncrypted') : ''));
      exportDialog.close();
    } catch (err) { showToast(err.message, true); }
  });

  $('#btn-import-cancel').addEventListener('click', () => {
    importDialog.close();
    resetImportDialog();
  });
  $('#btn-import-close').addEventListener('click', () => {
    importDialog.close();
    resetImportDialog();
  });
  $('#btn-import-confirm').addEventListener('click', async () => {
    const btn = $('#btn-import-confirm');
    const mode = $('#import-mode').value;
    const password = $('#import-password').value;

    try {
      btn.disabled = true;

      if (!state.importPending) {
        const picked = await unwrap(api.pickImportFile());
        if (!picked) return;

        state.importPending = picked;
        const fileHint = $('#import-file-hint');
        fileHint.textContent = t('importDialog.picked', {
          name: picked.fileName,
          encrypted: picked.encrypted ? t('importDialog.encryptedSuffix') : '',
        });
        fileHint.classList.remove('hidden');

        if (picked.encrypted) {
          $('#import-password-wrap').classList.remove('hidden');
          btn.textContent = t('common.import');
          $('#import-password').focus();
          return;
        }
      }

      if (state.importPending.encrypted && !password.trim()) {
        showToast(t('toast.enterDecryptPassword'), true);
        $('#import-password').focus();
        return;
      }

      await finishImport(state.importPending.content, mode, password);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('#btn-pick-cn').addEventListener('click', (e) => handleEditionPick(e.currentTarget));
  $('#btn-pick-intl').addEventListener('click', (e) => handleEditionPick(e.currentTarget));
  $('#btn-edition-pick-close').addEventListener('click', () => editionPickDialog.close());

  $('#btn-import-trae-cn').addEventListener('click', (e) =>
    withImportBusy(e.currentTarget, () => startTraeImportFor('cn')));
  $('#btn-import-trae-intl').addEventListener('click', (e) =>
    withImportBusy(e.currentTarget, () => startTraeImportFor('intl')));
}
