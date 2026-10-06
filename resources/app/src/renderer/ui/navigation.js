import { state } from '../core/state.js';
import { $, $$ } from '../core/utils.js';
import { loadUsageHistory } from './history.js';
import { scanCleanSize } from './clean.js';
import { loadMachinePanel } from './machine.js';
import { renderExpiryAlerts, updateOverview } from './overview.js';

export function switchPage(page) {
  state.currentPage = page;
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
  if (page === 'clean' && !state.cleanScanned && !state.cleanCleaning) scanCleanSize();
  if (page === 'overview') {
    updateOverview(state.allAccounts);
    loadUsageHistory();
    renderExpiryAlerts();
  }
  if (page === 'settings' && !state.machineInfoCache) loadMachinePanel();
  if (page === 'gateway') {
    import('./gateway.js').then((m) => m.loadGatewayPage()).catch(() => {});
  }
  if (page === 'models') {
    import('./models.js').then((m) => m.loadModelsPage()).catch(() => {});
  }
}

export function initNavigationEvents() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
}
