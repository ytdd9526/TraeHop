import { state } from '../core/state.js';
import { $ } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { saveSettings } from './settings.js';
import { api } from '../core/api.js';

const disclaimerDialog = $('#disclaimer-dialog');

export function setDisclaimerMode(required) {
  state.disclaimerRequired = required;
  $('#btn-disclaimer-decline').classList.toggle('hidden', !required);
  $('#btn-disclaimer-accept').textContent = required ? t('disclaimer.accept') : t('common.close');
}

export function showDisclaimer({ required = false } = {}) {
  if (!disclaimerDialog) return;
  setDisclaimerMode(required);
  disclaimerDialog.showModal();
}

export async function ensureDisclaimerAccepted() {
  if (state.appSettings.disclaimerAccepted) return true;
  showDisclaimer({ required: true });
  return new Promise((resolve) => {
    disclaimerDialog._resolveDisclaimer = resolve;
  });
}

function handleDisclaimerAccept() {
  if (state.disclaimerRequired) {
    saveSettings({
      disclaimerAccepted: true,
      disclaimerAcceptedAt: Date.now(),
    }).then(() => {
      disclaimerDialog.close();
      if (disclaimerDialog._resolveDisclaimer) {
        disclaimerDialog._resolveDisclaimer(true);
        disclaimerDialog._resolveDisclaimer = null;
      }
    });
  } else {
    disclaimerDialog.close();
  }
}

function handleDisclaimerDecline() {
  api.quitApp();
}

export function initDisclaimerEvents() {
  $('#btn-show-disclaimer').addEventListener('click', () => showDisclaimer({ required: false }));
  $('#btn-disclaimer-accept').addEventListener('click', handleDisclaimerAccept);
  $('#btn-disclaimer-decline').addEventListener('click', handleDisclaimerDecline);
  disclaimerDialog?.addEventListener('cancel', (e) => {
    if (state.disclaimerRequired) e.preventDefault();
  });
  disclaimerDialog?.addEventListener('click', (e) => {
    if (state.disclaimerRequired && e.target === disclaimerDialog) e.preventDefault();
  });
}
