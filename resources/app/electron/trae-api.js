const crypto = require('crypto');
const os = require('os');
const { fetchT } = require('./http');

const API_BASE_SG = 'https://api-sg-central.trae.ai';
const API_BASE_US = 'https://api-us-east.trae.ai';
const API_BASE_UG = 'https://ug-normal.trae.ai';
const API_BASE_CN = 'https://api.trae.cn';

// 2026-10 网关要求：请求须带完整设备头族，否则有效 token 也返回 401（与签到链路一致）
const IDE_VERSION = '1.107.1';

// 额度接口候选：CN 网关 v1 已收紧、走 v2；国际集群仍为 v1。region 头与集群配套
const ENTITLEMENT_CANDIDATES = [
  { base: API_BASE_CN, region: 'CN', path: '/trae/api/v2/pay/user_current_entitlement_list' },
  { base: API_BASE_SG, region: 'SG', path: '/trae/api/v1/pay/user_current_entitlement_list' },
  { base: API_BASE_US, region: 'US', path: '/trae/api/v1/pay/user_current_entitlement_list' },
];

function devicePlatformName() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'Darwin';
  return 'Linux';
}

function deriveDeviceId(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  const n = h.readBigUInt64BE(0) % 9000000000000000n + 1000000000000000n;
  return String(n);
}

function apiHeaders(token, region, deviceId) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-User-Region': region || 'CN',
    'x-device-id': deviceId,
    'x-device-type': devicePlatformName(),
    'x-os-version': os.release() || '10.0.19045',
    'x-app-version': IDE_VERSION,
    'User-Agent': `Trae/${IDE_VERSION}`,
  };
}

function parseJwtPayload(token) {
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw new Error('无效的 JWT Token 格式');

  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (payload.length % 4)) % 4;
  payload += '='.repeat(pad);

  const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  return {
    userId: json.data?.id || json.sub || '',
    tenantId: json.data?.tenant_id || '',
    exp: json.exp || null,
  };
}

function isTokenExpired(token) {
  try {
    const { exp } = parseJwtPayload(token);
    if (!exp) return false;
    return exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

const SESSION_EXPIRING_SOON_MS = 3600000; // 1 hour — matches Trae token ExpiredAt semantics
const JWT_EXPIRING_SOON_MS = 3600000;

function parseExpiryMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return value > 1e12 ? value : value * 1000;
  }
  const ts = Date.parse(String(value));
  return Number.isNaN(ts) ? null : ts;
}

function getAccountSessionExpiryMs(account) {
  return parseExpiryMs(account?.tokenExpiredAt);
}

function getAccountJwtExpiryMs(token) {
  try {
    const { exp } = parseJwtPayload(token);
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function getAccountDisplayExpiryMs(account) {
  return getAccountSessionExpiryMs(account) ?? getAccountJwtExpiryMs(account?.token);
}

function isAccountTokenExpired(account) {
  if (!account?.token) return false;

  const sessionExp = getAccountSessionExpiryMs(account);
  if (sessionExp) return sessionExp < Date.now();

  if (isTokenExpired(account.token)) {
    return !(account.cookies && account.cookies.trim());
  }
  return false;
}

function isAccountTokenExpiringSoon(account) {
  if (!account?.token || isAccountTokenExpired(account)) return false;

  const sessionExp = getAccountSessionExpiryMs(account);
  if (sessionExp) {
    const remaining = sessionExp - Date.now();
    return remaining > 0 && remaining < SESSION_EXPIRING_SOON_MS;
  }

  // JWT is short-lived; cookie refresh handles it — only warn when refresh is unavailable.
  if (account.cookies && account.cookies.trim()) return false;

  const jwtExp = getAccountJwtExpiryMs(account.token);
  if (!jwtExp || jwtExp <= Date.now()) return false;
  return jwtExp - Date.now() < JWT_EXPIRING_SOON_MS;
}

function cleanCookies(cookies) {
  if (!cookies || typeof cookies !== 'string') return '';
  return cookies
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('')
    .replace(/  +/g, ' ')
    .trim();
}

function detectApiBaseFromCookies(cookies) {
  const c = cleanCookies(cookies);
  if (c.includes('store-idc=cn') || c.includes('trae-target-idc=cn') || c.includes('trae.com.cn') || c.includes('trae.cn')) {
    return { base: API_BASE_CN, region: 'CN', origin: 'https://www.trae.cn' };
  }
  if (c.includes('store-idc=useast') || c.includes('trae-target-idc=useast')) {
    return { base: API_BASE_US, region: 'US', origin: 'https://www.trae.ai' };
  }
  if (c.includes('store-idc=alisg') || c.includes('trae-target-idc=alisg')) {
    return { base: API_BASE_SG, region: 'SG', origin: 'https://www.trae.ai' };
  }
  return { base: API_BASE_SG, region: 'SG', origin: 'https://www.trae.ai' };
}

function resolveExpiredAt(token, expiredAt) {
  if (expiredAt) return expiredAt;
  try {
    const { exp } = parseJwtPayload(token);
    if (exp) return new Date(exp * 1000).toISOString();
  } catch {
    /* ignore */
  }
  return null;
}

function parseGetUserTokenResponse(data) {
  const result = data?.Result || data?.result;
  if (!result) return null;
  const token = result.Token || result.token;
  if (!token) return null;
  const rawExpiredAt = result.ExpiredAt || result.expired_at || result.expiredAt || null;
  return {
    token,
    expiredAt: resolveExpiredAt(token, rawExpiredAt),
    userId: result.UserID || result.user_id || result.userId || '',
    tenantId: result.TenantID || result.tenant_id || result.tenantId || '',
  };
}

function expiredAtToUnix(expiredAt) {
  if (!expiredAt) return null;
  const ts = Date.parse(expiredAt);
  return Number.isNaN(ts) ? null : Math.floor(ts / 1000);
}

function extractUserTokenError(text) {
  try {
    const err = JSON.parse(text)?.ResponseMetadata?.Error;
    if (err?.Code) return { code: err.Code, message: err.Message || err.Code };
  } catch { /* ignore */ }
  return { code: null, message: '' };
}

// web 会话端点（/cloudide/api/v3/*：GetUserToken / GetUserInfo）用浏览器风格头——
// 原版 traehop 实测可用；带 IDE 设备头族（X-User-Region/x-device-*）会被拒成 401 The user is not logged in
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function browserHeaders(origin, { token, cookies } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': BROWSER_UA,
  };
  if (token) headers.Authorization = `Cloud-IDE-JWT ${token}`;
  if (cookies) headers.Cookie = cookies;
  return headers;
}

function originForBase(base) {
  return base === API_BASE_CN ? 'https://www.trae.cn' : 'https://www.trae.ai';
}

// 周年礼包直调（对齐 Trae-Account-Manager trae_api.rs：站点头族 + Cloud-IDE-JWT，
// 空体 POST），替代浏览器开礼包页点按钮——快且绕开站点风控
async function claimBirthdayBonus(token) {
  if (!token) throw new Error('Token 为空，无法领取礼包');

  let lastError = '领取礼包失败';
  for (const base of [API_BASE_SG, API_BASE_US]) {
    try {
      const res = await fetchT(`${base}/trae/api/v1/pay/claim_birthday_bonus`, {
        method: 'POST',
        headers: browserHeaders('https://www.trae.ai', { token }),
        body: '{}',
      });
      const text = await res.text();

      if (res.ok) {
        let apiErr = '';
        try { apiErr = JSON.parse(text)?.ResponseMetadata?.Error?.Message || ''; } catch { /* 非 JSON */ }
        if (apiErr) { lastError = apiErr; continue; }
        return { claimed: true, message: '' };
      }
      // 已领取/活动结束等业务拒绝：不算错误，调用方记日志即可
      if (res.status === 400 || res.status === 409) {
        return { claimed: false, message: `HTTP ${res.status} ${text.slice(0, 120)}` };
      }
      lastError = `claim_birthday_bonus ${res.status} ${text.slice(0, 120)}`;
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(lastError);
}

async function getUserToken(cookies) {
  const cleaned = cleanCookies(cookies);
  if (!cleaned) throw new Error('Cookie 为空，无法刷新 Token');

  const detected = detectApiBaseFromCookies(cleaned);
  const bases = [detected.base, API_BASE_CN, API_BASE_SG, API_BASE_US];
  const seen = new Set();

  let lastError = '刷新 Token 失败';

  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);

    const headers = browserHeaders(originForBase(base), { cookies: cleaned });

    try {
      const res = await fetchT(`${base}/cloudide/api/v3/common/GetUserToken`, {
        method: 'POST',
        headers,
        body: '{}',
      });

      const raw = await res.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch { /* 非 JSON 响应 */ }

      if (!res.ok) {
        const err = extractUserTokenError(raw);
        if (err.code === 20101 || err.code === 20102) {
          lastError = `登录 Cookie 已失效或被轮换（code ${err.code}），请在账号卡片重新浏览器续登`;
        } else if (err.message) {
          lastError = `GetUserToken 返回 ${res.status}：${err.message}`;
        } else {
          lastError = `GetUserToken 返回 ${res.status}`;
        }
        continue;
      }

      if (data?.ResponseMetadata?.Error?.Code) {
        lastError = data.ResponseMetadata.Error.Message || data.ResponseMetadata.Error.Code;
        continue;
      }

      const parsed = parseGetUserTokenResponse(data);
      if (!parsed) {
        lastError = 'GetUserToken 响应格式无效';
        continue;
      }

      const jwt = parseJwtPayload(parsed.token);
      return {
        ...parsed,
        tokenExp: jwt.exp || expiredAtToUnix(parsed.expiredAt),
      };
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(lastError);
}

function normalizeUserInfo(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.Error) return null;
  return {
    name: result.ScreenName || result.screen_name || '',
    email: result.NonPlainTextEmail || result.non_plain_text_email || result.Email || result.email || '',
    avatarUrl: result.AvatarUrl || result.avatar_url || '',
    region: result.Region || result.region || '',
  };
}

function mergeProfile(base, incoming) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

async function getUserInfoWithToken(token) {
  const endpoints = [
    { base: API_BASE_UG },
    { base: API_BASE_CN },
    { base: API_BASE_SG },
    { base: API_BASE_US },
  ];
  for (const cand of endpoints) {
    try {
      const res = await fetchT(`${cand.base}/cloudide/api/v3/trae/GetUserInfo`, {
        method: 'POST',
        headers: browserHeaders(originForBase(cand.base), { token }),
        body: JSON.stringify({ IfWebPage: true }),
      });
      const data = await res.json();
      if (data.ResponseMetadata?.Error?.Code) continue;
      const profile = normalizeUserInfo(data.Result || data.result);
      if (profile) return profile;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

async function getUserInfoWithCookies(cookies) {
  if (!cookies || !cookies.trim()) return null;
  const cleaned = cookies.trim();
  const endpoints = [
    { base: API_BASE_UG },
    { base: API_BASE_CN },
    { base: API_BASE_SG },
    { base: API_BASE_US },
  ];

  for (const cand of endpoints) {
    try {
      const res = await fetchT(`${cand.base}/cloudide/api/v3/trae/GetUserInfo`, {
        method: 'POST',
        headers: browserHeaders(originForBase(cand.base), { cookies: cleaned }),
        body: JSON.stringify({ IfWebPage: true }),
      });
      const data = await res.json();
      if (data.ResponseMetadata?.Error?.Code) continue;
      const profile = normalizeUserInfo(data.Result || data.result);
      if (profile?.email || profile?.name) return profile;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

async function resolveUserProfile(token, extras = {}) {
  const jwt = parseJwtPayload(token);
  let profile = {
    name: extras.name || extras.username || '',
    email: extras.email || '',
    avatarUrl: extras.avatarUrl || '',
    region: extras.region || '',
  };

  if (extras.cookies) {
    const fromCookies = await getUserInfoWithCookies(extras.cookies);
    if (fromCookies) profile = mergeProfile(profile, fromCookies);
  }

  if (!profile.email || !profile.avatarUrl) {
    const fromToken = await getUserInfoWithToken(token);
    if (fromToken) profile = mergeProfile(profile, fromToken);
  }

  if (!profile.name) {
    profile.name = profile.email || `User_${jwt.userId.slice(0, 8)}`;
  }

  return {
    userId: jwt.userId,
    tenantId: jwt.tenantId,
    name: profile.name,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    region: profile.region || 'SG',
    tokenExp: jwt.exp,
  };
}

function parseEntitlementsToSummary(data) {
  const isDollarBilling = !!data.is_dollar_usage_billing;

  const summary = {
    isDollarBilling,
    planType: 'Free',
    resetTime: 0,
    basicUsageUsed: 0,
    basicUsageLimit: 0,
    bonusUsageUsed: 0,
    bonusUsageLimit: 0,
    displayUsed: 0,
    displayLimit: 0,
    displayLeft: 0,
    exhausted: false,
    fastRequestUsed: 0,
    fastRequestLimit: 0,
    fastRequestLeft: 0,
    extraFastRequestUsed: 0,
    extraFastRequestLimit: 0,
    extraFastRequestLeft: 0,
    extraExpireTime: 0,
    extraPackageName: '',
    slowRequestUsed: 0,
    slowRequestLimit: 0,
    slowRequestLeft: 0,
    advancedModelUsed: 0,
    advancedModelLimit: 0,
    advancedModelLeft: 0,
    autocompleteUsed: 0,
    autocompleteLimit: 0,
    autocompleteLeft: 0,
  };

  for (const pack of data.user_entitlement_pack_list || []) {
    const base = pack.entitlement_base_info || {};
    const usage = pack.usage || {};
    const quota = base.quota || {};

    if (pack.display_desc) {
      summary.planType = pack.display_desc.replace(/\s*plan$/i, '');
    }

    if (base.product_type === 2) {
      if (isDollarBilling) {
        summary.bonusUsageLimit += quota.bonus_usage_limit || quota.basic_usage_limit || 0;
        summary.bonusUsageUsed += usage.bonus_usage_amount || usage.basic_usage_amount || 0;
      } else {
        summary.extraFastRequestLimit += quota.premium_model_fast_request_limit || 0;
        summary.extraFastRequestUsed += usage.premium_model_fast_amount || 0;
      }
      summary.extraExpireTime = base.end_time || 0;
      const pkgExtra = base.product_extra?.package_extra;
      if (pkgExtra?.package_source_type === 6) {
        summary.extraPackageName = '2026 Anniversary Treat';
      }
    } else {
      if (!pack.display_desc) {
        summary.planType = base.product_id === 0 ? 'Free' : 'Pro';
      }
      summary.resetTime = base.end_time || 0;

      if (isDollarBilling) {
        summary.basicUsageLimit = quota.basic_usage_limit || 0;
        summary.basicUsageUsed = usage.basic_usage_amount || 0;
        summary.bonusUsageLimit = quota.bonus_usage_limit || 0;
        summary.bonusUsageUsed = usage.bonus_usage_amount || 0;
      }

      summary.fastRequestLimit = quota.premium_model_fast_request_limit || 0;
      summary.fastRequestUsed = usage.premium_model_fast_request_usage ?? usage.premium_model_fast_amount ?? 0;
      summary.fastRequestLeft = summary.fastRequestLimit - summary.fastRequestUsed;

      summary.slowRequestLimit = quota.premium_model_slow_request_limit || 0;
      summary.slowRequestUsed = usage.premium_model_slow_request_usage ?? usage.premium_model_slow_amount ?? 0;
      summary.slowRequestLeft = summary.slowRequestLimit - summary.slowRequestUsed;

      summary.advancedModelLimit = quota.advanced_model_request_limit || 0;
      summary.advancedModelUsed = usage.advanced_model_request_usage ?? usage.advanced_model_amount ?? 0;
      summary.advancedModelLeft = summary.advancedModelLimit - summary.advancedModelUsed;

      summary.autocompleteLimit = quota.auto_completion_limit || 0;
      summary.autocompleteUsed = usage.auto_completion_usage ?? usage.auto_completion_amount ?? 0;
      summary.autocompleteLeft = summary.autocompleteLimit - summary.autocompleteUsed;
    }
  }

  summary.extraFastRequestLeft = summary.extraFastRequestLimit - summary.extraFastRequestUsed;

  if (isDollarBilling) {
    summary.displayUsed = summary.basicUsageUsed + summary.bonusUsageUsed;
    summary.displayLimit = summary.basicUsageLimit + summary.bonusUsageLimit;
    summary.displayLeft = Math.max(0, summary.displayLimit - summary.displayUsed);
    summary.exhausted = summary.displayLimit > 0 && summary.displayUsed >= summary.displayLimit;
  } else {
    summary.displayUsed = summary.fastRequestUsed + summary.extraFastRequestUsed;
    summary.displayLimit = summary.fastRequestLimit + summary.extraFastRequestLimit;
    summary.displayLeft = Math.max(0, summary.displayLimit - summary.displayUsed);
    summary.exhausted = summary.displayLimit > 0 && summary.displayUsed >= summary.displayLimit;
  }

  return summary;
}

// 响应双格式兼容：usage_summary（v2 顶层汇总，含签到积分）优先——国内账号积分只在这里，
// pack_list 优先会把积分丢成 0/0；pack_list（国际 v1 完整数据）兜底
function summarizeEntitlements(data) {
  const s = data?.usage_summary;
  if (s && (s.total_amount != null || s.consumed_amount != null)) {
    const packs = data?.user_entitlement_pack_list;
    const summary = parseEntitlementsToSummary(Array.isArray(packs) && packs.length ? data : {});
    const used = Number(s.consumed_amount) || 0;
    const total = Number(s.total_amount) || 0;
    return {
      ...summary,
      isDollarBilling: !!data?.is_dollar_usage_billing,
      displayUsed: used,
      displayLimit: total,
      displayLeft: Math.max(0, total - used),
      exhausted: total > 0 && used >= total,
    };
  }

  const packs = data?.user_entitlement_pack_list;
  if (Array.isArray(packs) && packs.length) {
    return parseEntitlementsToSummary(data);
  }
  return null;
}

// edition 路由：cn 账号只打 CN 基站，intl 只打国际集群；不传时全列表探测（添加账号时版本未知）
function entitlementCandidatesFor(edition) {
  if (edition === 'cn') return ENTITLEMENT_CANDIDATES.filter((c) => c.base === API_BASE_CN);
  if (edition === 'intl') return ENTITLEMENT_CANDIDATES.filter((c) => c.base !== API_BASE_CN);
  return ENTITLEMENT_CANDIDATES;
}

async function fetchEntitlements(token, edition) {
  const deviceId = deriveDeviceId(`traehop-api:${parseJwtPayload(token).userId}`);
  let lastError = '获取额度失败';

  for (const cand of entitlementCandidatesFor(edition)) {
    try {
      let res = await fetchT(`${cand.base}${cand.path}`, {
        method: 'POST',
        headers: apiHeaders(token, cand.region, deviceId),
        body: JSON.stringify({ require_usage: true, full_data: true }),
      });
      // 站点签发的 Token（注册链路 GetUserToken 直调）配 IDE 设备头可能被拒 401/403，
      // 换浏览器头族重试一次（参考 Trae-Account-Manager：站点 Token + 站点头全链路可通）
      if (res.status === 401 || res.status === 403) {
        res = await fetchT(`${cand.base}${cand.path}`, {
          method: 'POST',
          headers: browserHeaders(originForBase(cand.base), { token }),
          body: JSON.stringify({ require_usage: true, full_data: true }),
        });
      }

      if (!res.ok) {
        lastError = `API 返回 ${res.status}`;
        continue;
      }

      const data = await res.json();
      const summary = summarizeEntitlements(data);
      if (summary) return { summary, data };
      lastError = '额度响应格式无效';
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(lastError);
}

async function getUsageSummary(token, edition) {
  if (isTokenExpired(token)) {
    throw new Error('Token 已过期');
  }
  const { summary } = await fetchEntitlements(token, edition);
  return summary;
}

async function validateToken(token, extras = {}) {
  const jwt = parseJwtPayload(token);
  const { data } = await fetchEntitlements(token);
  const pack = data.user_entitlement_pack_list?.[0];
  const userId = pack?.entitlement_base_info?.user_id || jwt.userId;
  const profile = await resolveUserProfile(token, {
    ...extras,
    region: pack?.entitlement_base_info?.region || extras.region,
  });

  return {
    ...profile,
    userId,
    tenantId: jwt.tenantId || profile.tenantId,
    tokenExp: jwt.exp,
  };
}

module.exports = {
  validateToken,
  resolveUserProfile,
  parseJwtPayload,
  getUsageSummary,
  getUserToken,
  claimBirthdayBonus,
  isTokenExpired,
  isAccountTokenExpired,
  isAccountTokenExpiringSoon,
  getAccountDisplayExpiryMs,
  parseEntitlementsToSummary,
  cleanCookies,
  resolveExpiredAt,
};
