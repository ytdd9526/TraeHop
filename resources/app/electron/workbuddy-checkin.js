const WORKBUDDY_UA = 'WorkBuddy';

const { fetchT } = require('./http');

function buildHeaders(token, uid, enterpriseId, domain) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-User-Id': String(uid),
    'User-Agent': WORKBUDDY_UA,
  };
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = String(enterpriseId);
    headers['X-Tenant-Id'] = String(enterpriseId);
  }
  if (domain) headers['X-Domain'] = String(domain);
  return headers;
}

async function workbuddyRequest(url, headers, body = {}) {
  const res = await fetchT(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, data };
}

function isTokenExpired(status, data) {
  if (status === 401 || status === 403) return true;
  const code = data?.code ?? data?.error_code;
  return code === 401 || code === 403;
}

async function workbuddyGetStatus(endpoint, token, uid, enterpriseId, domain) {
  const url = `${endpoint}/v2/billing/meter/checkin-activity-status`;
  const { status, data } = await workbuddyRequest(url, buildHeaders(token, uid, enterpriseId, domain), {});

  if (isTokenExpired(status, data)) {
    const err = new Error('WorkBuddy Token 已过期，请重新登录');
    err.code = 'WORKBUDDY_TOKEN_EXPIRED';
    throw err;
  }

  if (status !== 200) {
    throw new Error(data?.msg || data?.message || `状态查询失败: HTTP ${status}`);
  }

  return {
    todayCheckedIn: data?.today_checked_in === true,
    credits: data?.credit ?? data?.credits ?? 0,
    raw: data,
  };
}

async function workbuddyCheckin(endpoint, token, uid, enterpriseId, domain) {
  const url = `${endpoint}/v2/billing/meter/daily-checkin`;
  const { status, data } = await workbuddyRequest(url, buildHeaders(token, uid, enterpriseId, domain), {});

  if (isTokenExpired(status, data)) {
    const err = new Error('WorkBuddy Token 已过期，请重新登录');
    err.code = 'WORKBUDDY_TOKEN_EXPIRED';
    throw err;
  }

  const code = data?.code;
  const msg = data?.msg || data?.message || '';

  if (status === 200) {
    if (typeof data?.credit === 'number' || typeof data?.credits === 'number') {
      return { status: 'checked', points: data.credit ?? data.credits ?? 0, raw: data };
    }
    if (data?.today_checked_in === true || msg.includes('今天已签到')) {
      return { status: 'already', points: 0, raw: data };
    }
    return { status: 'failed', message: msg || '签到响应异常', raw: data };
  }

  if (code === 10001 && msg.includes('今天已签到')) {
    return { status: 'already', points: 0, raw: data };
  }

  return { status: 'failed', message: msg || `签到失败: HTTP ${status}`, raw: data };
}

async function workbuddyDailyCheckin(endpoint, token, uid, enterpriseId, domain) {
  const status = await workbuddyGetStatus(endpoint, token, uid, enterpriseId, domain);
  if (status.todayCheckedIn) {
    return { status: 'already', points: status.credits, raw: status.raw };
  }
  return workbuddyCheckin(endpoint, token, uid, enterpriseId, domain);
}

module.exports = { workbuddyGetStatus, workbuddyCheckin, workbuddyDailyCheckin, buildHeaders };
