const Store = require('electron-store');
const accountStore = require('./account-store');
const { ensureDataDir } = require('./data-path');
const traeCheckin = require('./trae-checkin');
const { workbuddyDailyCheckin } = require('./workbuddy-checkin');

const wbStore = new Store({ name: 'traehop-checkin-workbuddy', cwd: ensureDataDir() });

function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function getWbState() {
  const saved = wbStore.get('state', null);
  if (!saved || saved.date !== todayKey()) {
    return { date: todayKey(), results: {} };
  }
  return saved;
}

function saveWbState(state) {
  wbStore.set('state', state);
}

function recordWbResult(id, entry) {
  const state = getWbState();
  state.results[id] = { ...entry, time: Date.now() };
  saveWbState(state);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLAIM_GAP_MS = 8000;

async function runWorkbuddyCheckin(brief, onLog) {
  const id = brief.id;
  const label = brief.name || brief.wbUid || id;
  const account = accountStore.getAccount(id);

  const prev = getWbState().results[id];
  if (prev && (prev.status === 'checked' || prev.status === 'already')) {
    return { id, status: 'skipped', points: prev.points || 0, claimed: false };
  }

  try {
    const result = await workbuddyDailyCheckin(
      account.wbEndpoint,
      account.token,
      account.wbUid,
      account.wbEnterpriseId,
      account.wbDomain
    );
    if (result.status === 'checked') {
      recordWbResult(id, { status: 'checked', points: result.points, message: '签到成功' });
      onLog(`🎉 [${label}] WorkBuddy 签到成功 +${result.points}`);
      return { id, status: 'checked', points: result.points, claimed: true };
    }
    if (result.status === 'already') {
      recordWbResult(id, { status: 'already', points: result.points, message: '今日已签' });
      onLog(`☑️ [${label}] WorkBuddy 今日已签`);
      return { id, status: 'already', points: result.points, claimed: false };
    }
    const message = result.message || '签到失败';
    recordWbResult(id, { status: 'failed', points: 0, message });
    onLog(`❌ [${label}] ${message}`);
    return { id, status: 'failed', message, claimed: true };
  } catch (err) {
    const code = err.code || err.message;
    const status = code === 'WORKBUDDY_TOKEN_EXPIRED' ? 'failed' : 'failed';
    recordWbResult(id, { status, points: 0, message: err.message });
    onLog(`❌ [${label}] ${err.message}`);
    return { id, status, message: err.message, claimed: true };
  }
}

async function checkinOne(id, onLog = () => {}) {
  const account = accountStore.getAccount(id);
  if (!account) throw new Error('账号不存在');

  if (account.platform === 'workbuddy') {
    return runWorkbuddyCheckin({ id, name: account.name, wbUid: account.wbUid }, onLog);
  }
  return traeCheckin.checkinOne(id, onLog);
}

async function runCheckinAll(onLog = () => {}) {
  const briefs = await accountStore.listAccounts();
  const results = [];
  let claimedLast = false;

  for (const brief of briefs) {
    if (claimedLast) await sleep(CLAIM_GAP_MS + Math.floor(Math.random() * 2000));

    let result;
    try {
      if (brief.platform === 'workbuddy') {
        result = await runWorkbuddyCheckin(brief, onLog);
      } else {
        result = await traeCheckin.checkinOne(brief.id, onLog);
      }
    } catch (err) {
      result = { id: brief.id, status: 'failed', message: err.message, claimed: false };
    }

    claimedLast = !!result.claimed;
    results.push(result);
  }

  return { date: todayKey(), results };
}

function getCheckinState() {
  const traeState = traeCheckin.getCheckinState();
  const wbState = getWbState();
  const merged = { ...traeState.results, ...wbState.results };
  return { date: todayKey(), results: merged };
}

module.exports = { runCheckinAll, getCheckinState, checkinOne };
