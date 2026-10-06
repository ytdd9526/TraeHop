import { state } from '../core/state.js';
import { api, unwrap } from '../core/api.js';
import { t } from '../core/i18n.js';
import { $, escapeHtml, formatTs } from '../core/utils.js';

export async function loadUsageHistory() {
  try {
    const history = await unwrap(api.getUsageHistory());
    const currentIds = new Set(state.allAccounts.filter((a) => a.isCurrent).map((a) => a.id));
    const visible = currentIds.size ? history.filter((h) => currentIds.has(h.accountId)) : [];
    const el = $('#usage-history');
    const header = document.querySelector('.history-header');
    if (!visible.length) {
      if (el) el.innerHTML = `<p class="muted">${escapeHtml(t('overview.historyEmpty'))}</p>`;
      header?.classList.add('hidden');
      return;
    }
    header?.classList.remove('hidden');
    if (el) {
      el.innerHTML = visible.slice(0, 20).map((h) => {
        const left = h.isDollarBilling ? `$${Number(h.left).toFixed(2)}` : Math.round(h.left);
        return `<div class="history-row"><span class="history-email">${escapeHtml(h.email || '—')}</span><span class="history-val">${escapeHtml(t('overview.historyLeftVal', { left }))}</span><span class="history-time">${formatTs(h.timestamp)}</span></div>`;
      }).join('');
    }
  } catch { /* optional */ }
}
