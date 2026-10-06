import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $, $$, extractTokenPayload } from '../core/utils.js';
import { showToast } from './common.js';
import { refreshAccounts } from './accounts.js';
import { switchPage } from './navigation.js';

const addDialog = $('#add-dialog');

function updateAddDialogFooter() {
  const isWb = state.addPlatform === 'workbuddy';
  $('#btn-submit-add').classList.toggle('hidden', !isWb && state.addMode !== 'token');
  $('#btn-cancel-browser').classList.toggle('hidden', !isWb && (state.addMode !== 'browser' || !state.browserLoginActive));
}

function resetBrowserLoginState() {
  state.browserLoginActive = false;
  state.reloginAccountId = null;
  $('#btn-browser-login').disabled = false;
  $('#browser-login-status').classList.add('hidden');
  updateAddDialogFooter();
}

function resetWorkbuddyForm() {
  $('#wb-endpoint').value = '';
  $('#wb-uid').value = '';
  $('#wb-token').value = '';
  $('#wb-enterprise-id').value = '';
  $('#wb-domain').value = '';
  $('#workbuddy-detect-status').classList.add('hidden');
}

export async function closeAddDialog() {
  if (state.browserLoginActive) await api.cancelBrowserLogin().catch(() => {});
  resetBrowserLoginState();
  addDialog.close();
}

function setAddMode(mode) {
  state.addMode = mode;
  $$('#add-form-trae .add-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  $('#panel-browser').classList.toggle('hidden', mode !== 'browser');
  $('#panel-token').classList.toggle('hidden', mode !== 'token');
  $('#panel-trae').classList.toggle('hidden', mode !== 'trae');
  updateAddDialogFooter();
}

export function showAddStep(platform) {
  state.addPlatform = platform;
  $('#add-step-platform').classList.toggle('hidden', !!platform);
  $('#add-step-form').classList.toggle('hidden', !platform);
  $('#add-form-trae').classList.toggle('hidden', platform !== 'trae');
  $('#add-form-workbuddy').classList.toggle('hidden', platform !== 'workbuddy');
  $('#add-dialog-title').textContent = platform
    ? `${t('platform.addAccount')} — ${t(`platform.${platform}`)}`
    : t('accounts.addAccount');

  if (platform === 'trae') {
    resetBrowserLoginState();
    setAddMode('browser');
  } else if (platform === 'workbuddy') {
    resetWorkbuddyForm();
    updateAddDialogFooter();
  }
}

export function openAddDialog(platform = null) {
  $('#token-input').value = '';
  resetBrowserLoginState();
  resetWorkbuddyForm();
  showAddStep(platform);
  addDialog.showModal();
}

export function initAddAccountEvents() {
  $$('.add-tab').forEach((tab) => tab.addEventListener('click', () => setAddMode(tab.dataset.mode)));
  $('#btn-dialog-close').addEventListener('click', closeAddDialog);
  $('#btn-cancel-add').addEventListener('click', closeAddDialog);
  addDialog.addEventListener('click', (e) => { if (e.target === addDialog) closeAddDialog(); });
  addDialog.addEventListener('cancel', (e) => { e.preventDefault(); closeAddDialog(); });

  $$('.platform-card').forEach((card) => card.addEventListener('click', () => showAddStep(card.dataset.platform)));
  $('#btn-add-back').addEventListener('click', () => showAddStep(null));

  $('#btn-browser-login').addEventListener('click', async () => {
    $('#btn-browser-login').disabled = true;
    state.browserLoginActive = true;
    updateAddDialogFooter();
    const status = $('#browser-login-status');
    status.classList.remove('hidden');
    status.textContent = t('addDialog.loginWaiting');
    try { await unwrap(api.startBrowserLogin()); }
    catch (err) { status.textContent = err.message; resetBrowserLoginState(); }
  });

  $('#btn-cancel-browser').addEventListener('click', async () => {
    await api.cancelBrowserLogin().catch(() => {});
    resetBrowserLoginState();
  });

  $('#btn-submit-add').addEventListener('click', async () => {
    const btn = $('#btn-submit-add');
    btn.disabled = true;
    btn.textContent = t('addDialog.adding');
    try {
      if (state.addPlatform === 'workbuddy') {
        const endpoint = $('#wb-endpoint').value.trim();
        const uid = $('#wb-uid').value.trim();
        const token = $('#wb-token').value.trim();
        const enterpriseId = $('#wb-enterprise-id').value.trim() || undefined;
        const domain = $('#wb-domain').value.trim() || undefined;
        if (!endpoint || !uid || !token) {
          showToast('请填写 Endpoint、UID 和 Token', true);
          return;
        }
        await unwrap(api.addWorkbuddyAccount({ endpoint, uid, token, enterpriseId, domain }));
      } else {
        const payload = extractTokenPayload($('#token-input').value);
        if (!payload?.token) { showToast(t('toast.invalidToken'), true); return; }
        await unwrap(api.addAccount(payload.token, payload.tokenExpiredAt || undefined));
      }
      await closeAddDialog();
      switchPage('accounts');
      showToast(t('toast.added'));
      await refreshAccounts({ syncMessage: t('sync.adding') });
    } catch (err) { showToast(err.message, true); }
    finally {
      btn.disabled = false;
      btn.textContent = t('addDialog.submit');
    }
  });

  $('#btn-import-in-dialog').addEventListener('click', () => {
    import('./import-export.js').then(({ startTraeImport, withImportBusy }) => {
      withImportBusy($('#btn-import-in-dialog'), async () => {
        const done = await startTraeImport();
        if (done) {
          await closeAddDialog();
          switchPage('accounts');
        }
      });
    });
  });

  $('#btn-detect-workbuddy').addEventListener('click', async () => {
    const btn = $('#btn-detect-workbuddy');
    const status = $('#workbuddy-detect-status');
    btn.disabled = true;
    status.classList.remove('hidden');
    status.textContent = t('workbuddy.detecting');
    try {
      const creds = await unwrap(api.detectWorkbuddyCredentials());
      $('#wb-endpoint').value = creds.endpoint || '';
      $('#wb-uid').value = creds.uid || '';
      $('#wb-token').value = creds.token || '';
      $('#wb-enterprise-id').value = creds.enterpriseId || '';
      $('#wb-domain').value = creds.domain || '';
      status.textContent = t('workbuddy.detected');
    } catch (err) {
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}
