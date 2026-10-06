
const crypto = require('crypto');
const os = require('os');
const Store = require('electron-store');
const { ensureDataDir } = require('./data-path');
const { fetchT } = require('./http');
const accountStore = require('./account-store');

// 签到 API 按版本路由：CN 固定 api.trae.cn/v2；INTL 未逆向确认域名与版本，
// status 先探测（404 换候选），命中的候选再用于 claim（claim 有副作用不可探测）
const CHECKIN_CANDIDATES = {
  cn: [
    { base: 'https://api.trae.cn', status: '/trae/api/v2/ug/checkin_credits/status', claim: '/trae/api/v2/ug/checkin_credits/claim', region: 'CN' },
  ],
  intl: [
    { base: 'https://ug-normal.trae.ai', status: '/trae/api/v1/ug/checkin_credits/status', claim: '/trae/api/v1/ug/checkin_credits/claim', region: 'Other' },
    { base: 'https://grow-normal.trae.ai', status: '/trae/api/v1/ug/checkin_credits/status', claim: '/trae/api/v1/ug/checkin_credits/claim', region: 'Other' },
    { base: 'https://ug-normal.trae.ai', status: '/trae/api/v2/ug/checkin_credits/status', claim: '/trae/api/v2/ug/checkin_credits/claim', region: 'Other' },
    { base: 'https://grow-normal.trae.ai', status: '/trae/api/v2/ug/checkin_credits/status', claim: '/trae/api/v2/ug/checkin_credits/claim', region: 'Other' },
  ],
};

const IDE_VERSION = '1.107.1';
const REQ_BODY = JSON.stringify({ req_source: 1 });
const RATE_CODE = 9074;
const ALREADY_CODE = 9095;
const AUTH_FAIL_CODES = new Set([1001, 1002, 401, 403]);
const CLAIM_GAP_MS = 4000;

const store = new Store({ name: 'traehop-checkin', cwd: ensureDataDir() });

function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function getState() {
  const saved = store.get('state', null);
  if (!saved || saved.date !== todayKey() || !saved.deviceIds) {
    return { date: todayKey(), results: {}, deviceIds: saved?.deviceIds || {} };
  }
  return saved;
}

function saveState(state) {
  store.set('state', state);
}

function deviceKeyOf(account) {
  return String(account.userId || account.id);
}

function genDeviceId(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  const n = h.readBigUInt64BE(0) % 9000000000000000n + 1000000000000000n;
  return String(n);
}

// 设备号由账号 machineId 唯一确定，保证同一账号永远使用同一虚拟设备，避免被服务端统计为多设备
function stableDeviceId(machineId) {
  return genDeviceId(`traehop:device:${machineId}`);
}

function deviceIdFor(account) {
  let machineId = account.machineId;
  if (!machineId) {
    // 旧数据没有 machineId：生成一个并回存账号库，后续永久绑定
    machineId = crypto.randomUUID();
    accountStore.setAccountMachineId(account.id, machineId);
  }
  return stableDeviceId(machineId);
}

function devicePlatformName() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'Darwin';
  return 'Linux';
}

// 版本判定与 account-store.js editionOfAccount 同规则：身份规则优先（@maxxspace.com=>
// intl、纯数字/用户\d+名=>cn），edition/region 仅兜底——否则点错导入版本会把国内账号签到打到国际集群
function editionOf(account) {
  const email = String(account?.email || '').toLowerCase();
  if (email.endsWith('@maxxspace.com')) return 'intl';
  const identity = String(account?.email || account?.name || '').trim();
  if (/^(用户)?\d+$/.test(identity)) return 'cn';
  if (account?.edition === 'intl' || account?.edition === 'cn') return account.edition;
  const region = String(account?.region || '').toUpperCase();
  return region && region !== 'CN' ? 'intl' : 'cn';
}

function checkinHeaders(token, deviceId, region) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-User-Region': region || 'CN',
    'User-Agent': `Trae/${IDE_VERSION}`,
    'x-device-id': deviceId,
    'x-device-type': devicePlatformName(),
    'x-os-version': os.release() || '10.0.19045',
    'x-app-version': IDE_VERSION,
  };
}

// 站点头族：站点签发的 Token（注册链路 GetUserToken 直调）配 IDE 设备头可能被拒，
// 401/403 时换此头重试（参考 Trae-Account-Manager：站点 Token + 站点头全链路可通）
function siteHeaders(cand, token) {
  const origin = /trae\.cn/i.test(cand.base) ? 'https://www.trae.cn' : 'https://www.trae.ai';
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Authorization: `Cloud-IDE-JWT ${token}`,
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

async function postCheckin(cand, endpointPath, token, deviceId) {
  try {
    let res = await fetchT(`${cand.base}${endpointPath}`, {
      method: 'POST',
      headers: checkinHeaders(token, deviceId, cand.region),
      body: REQ_BODY,
    });
    if (res.status === 401 || res.status === 403) {
      res = await fetchT(`${cand.base}${endpointPath}`, {
        method: 'POST',
        headers: siteHeaders(cand, token),
        body: REQ_BODY,
      });
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    return { http: res.status, body, error: null };
  } catch (err) {
    return { http: -1, body: null, error: err.message };
  }
}

const bodyCode = (r) => (r.body && typeof r.body.code === 'number' ? r.body.code : null);

const isAuthFail = (r) => bodyCode(r) !== null && AUTH_FAIL_CODES.has(bodyCode(r));

const isRateFail = (r) => bodyCode(r) === RATE_CODE || r.http === 429 || r.http >= 500;

async function claimOnce(cand, token, deviceId) {
  const r = await postCheckin(cand, cand.claim, token, deviceId);
  const points = r.body?.data?.points ?? null;
  const message = r.body?.message || r.error || `HTTP ${r.http}`;
  return { http: r.http, code: bodyCode(r), points, message };
}

// status 探测：404 视为候选不匹配换下一个（intl 域名/版本未定），其余状态即命中
async function probeStatus(edition, token, deviceId) {
  const candidates = CHECKIN_CANDIDATES[edition === 'intl' ? 'intl' : 'cn'];
  let last = null;
  for (const cand of candidates) {
    last = await postCheckin(cand, cand.status, token, deviceId);
    if (last.http !== 404) return { cand, st: last };
  }
  return { cand: null, st: last };
}

function recordResult(id, entry) {
  const state = getState();
  state.results[id] = { ...entry, time: Date.now() };
  saveState(state);
}

async function checkinAccount(brief, onLog) {
  const id = brief.id;
  const label = brief.email || brief.name || id;

  const prev = getState().results[id];
  if (prev && (prev.status === 'checked' || prev.status === 'already')) {
    return { id, status: 'skipped', points: prev.points || 0, claimed: false };
  }

  let account;
  try {
    account = accountStore.getAccount(id);
  } catch (err) {
    recordResult(id, { status: 'failed', points: 0, message: err.message });
    return { id, status: 'failed', message: err.message, claimed: false };
  }
  if (!account.token) {
    const message = '账号没有有效的 Token';
    recordResult(id, { status: 'failed', points: 0, message });
    onLog(`❌ [${label}] ${message}`);
    return { id, status: 'failed', message, claimed: false };
  }

  let token;
  try {
    token = await accountStore.ensureValidToken(id);
  } catch (err) {
    // early-fail 也必须记录，否则汇总里该账号凭空消失（用户看到 成功2+已签2 但总数对不上）
    recordResult(id, { status: 'failed', points: 0, message: err.message });
    onLog(`❌ [${label}] ${err.message}`);
    return { id, status: 'failed', message: err.message, claimed: false };
  }

  // 状态查询：body 必须带 req_source（与桌面端一致），空体会被服务端拒成 9074
  let { cand, st } = await probeStatus(editionOf(account), token, deviceIdFor(account));
  if (isAuthFail(st)) {
    try {
      token = await accountStore.ensureValidToken(id);
    } catch (err) {
      recordResult(id, { status: 'failed', points: 0, message: err.message });
      return { id, status: 'failed', message: err.message };
    }
    ({ cand, st } = await probeStatus(editionOf(account), token, deviceIdFor(account)));
    if (isAuthFail(st)) {
      const message = 'Token 鉴权失败，请续登该账号';
      recordResult(id, { status: 'failed', points: 0, message });
      return { id, status: 'failed', message };
    }
  }

  if (!cand || st.error || !st.body) {
    // 状态都拿不到就不浪费 claim 请求，等下轮再试
    const message = `状态查询失败：${st?.error || `HTTP ${st?.http}`}`;
    return { id, status: 'failed', message, claimed: false };
  }

  if (st.body.checked_in) {
    const credits = Number(st.body.credits) || 0;
    recordResult(id, { status: 'already', points: credits, message: '今日已签' });
    onLog(`☑️ [${label}] 今日已签（积分 ${credits}）`);
    return { id, status: 'already', points: credits, claimed: false };
  }

  if (st.body.enable === false) {
    recordResult(id, { status: 'closed', points: 0, message: '签到暂未开放' });
    onLog(`⏳ [${label}] 签到暂未开放`);
    return { id, status: 'closed', points: 0, claimed: false };
  }

  let attempt = await claimOnce(cand, token, deviceIdFor(account));
  if (attempt.code === RATE_CODE) {
    // 9074：不再更换设备号，延迟后重试一次；频繁换号才会被服务端记为多设备
    onLog(`🔄 [${label}] 命中 9074，延迟后重试`);
    await sleep(CLAIM_GAP_MS * 2);
    attempt = await claimOnce(cand, token, deviceIdFor(account));
  }

  if (attempt.code === 0) {
    const points = Number(attempt.points) || 0;
    recordResult(id, { status: 'checked', points, message: '签到成功' });
    onLog(`🎉 [${label}] 签到成功 +${points}`);
    return { id, status: 'checked', points, claimed: true };
  }
  if (attempt.code === ALREADY_CODE) {
    recordResult(id, { status: 'already', points: 0, message: '今日已签' });
    onLog(`☑️ [${label}] 今日已签`);
    return { id, status: 'already', points: 0, claimed: true };
  }
  if (isRateFail(attempt)) {
    const message = '9074 排队限流，稍后重新点一次签到即可补签';
    recordResult(id, { status: 'rate', points: 0, message });
    onLog(`⏳ [${label}] ${message}`);
    return { id, status: 'rate', points: 0, claimed: true };
  }

  const message = attempt.message || '签到失败';
  recordResult(id, { status: 'failed', points: 0, message });
  onLog(`❌ [${label}] ${message}`);
  return { id, status: 'failed', message, claimed: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getCheckinState() {
  const state = getState();
  return { date: state.date, results: state.results };
}

async function checkinOne(id, onLog = () => {}) {
  const account = accountStore.getAccount(id);
  if (!account) throw new Error('账号不存在');
  return checkinAccount({ id, email: account.email, name: account.name }, onLog);
}

module.exports = { getCheckinState, checkinOne };
