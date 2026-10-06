export const state = {
  toastTimer: null,
  usageMap: {},
  allAccounts: [],
  addMode: 'browser',
  addPlatform: null,
  browserLoginActive: false,
  reloginAccountId: null,
  currentPage: 'overview',
  quotaFilter: 'all',
  accountSearch: '',
  accountSort: 'default',
  selectedIds: new Set(),
  appSettings: {},
  autoRefreshTimer: null,
  lastRefreshTime: null,
  refreshDebounce: null,
  cleanCleaning: false,
  cleanScanned: false,
  lastBackupTs: null,
  cachedTraePath: null,
  initialLoading: true,
  accountsSyncing: false,
  accountsSyncMessage: '',
  importPending: null,
  checkinRunning: false,
  migrateRunning: false,
  registerRunning: false,
  overviewEdition: 'all',
  checkinState: { date: null, results: {} },
  checkinLoadingIds: new Set(),
  machineInfoCache: null,
  disclaimerRequired: false,
  platformCollapsed: {},
  usageCache: new Map(),
  usageCacheTtlMs: 60000,
};

try {
  const saved = localStorage.getItem('traehop:platformCollapsed');
  if (saved) state.platformCollapsed = JSON.parse(saved);
} catch {
  state.platformCollapsed = {};
}

export const PLATFORM_TYPES = ['trae', 'workbuddy'];
export const PLATFORM_ICONS = {
  trae: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
  workbuddy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/></svg>',
};
export const RING_CIRCUMFERENCE = 327;

export function savePlatformCollapsed() {
  try {
    localStorage.setItem('traehop:platformCollapsed', JSON.stringify(state.platformCollapsed));
  } catch { /* ignore */ }
}

export function resetUIState() {
  state.initialLoading = true;
  state.accountsSyncing = false;
  state.accountsSyncMessage = '';
  state.selectedIds.clear();
  state.checkinLoadingIds.clear();
  state.usageMap = {};
  state.usageCache.clear();
}
