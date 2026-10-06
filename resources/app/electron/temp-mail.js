// 临时邮箱供应商：guerrillamail（多域名：guerrillamailblock.com/sharklasers/grr.la 等，未被 trae 风控）。
// mail.tm 已移除：其唯一域名 maxxspace.com 被 trae 注册提交拦截（at-risk，09:33 实证），兜底=必败死路。
// 契约：start() 失败抛错（外层 3 次递增重试）、getEmail()、
// pollVerificationCode({attempts, intervalMs, shouldStop, onPoll, onDebug})。
const crypto = require('crypto');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHARS_LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(len, chars) {
  let out = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i += 1) out += chars[buf[i] % chars.length];
  return out;
}

async function fetchJson(url, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

// 验证码提取：主题优先 → 正文 6 位数字 → 字母数字混合码兜底
//（exec 全量扫描且须同时含字母+数字，跳过 VERIFY 等纯字母词）
function extractVerificationCode(subject, body) {
  const fromSubject = String(subject).match(/\b(\d{6})\b/);
  if (fromSubject) return fromSubject[1];

  const plain = String(body).replace(/<[^>]+>/g, ' ');
  const digits = plain.match(/\b(\d{6})\b/);
  if (digits) return digits[1];

  const hay = `${subject} ${plain}`.toUpperCase();
  const re = /\b([A-Z0-9]{6})\b/g;
  let m;
  while ((m = re.exec(hay))) {
    if (/[A-Z]/.test(m[1]) && /\d/.test(m[1])) return m[1];
  }
  return null;
}

// 轮询骨架：拉未读 → 去重 → onDebug 转储 → 提取验证码，两供应商共用
async function pollMailForCode(fetchNewMessages, { attempts = 12, intervalMs = 5000, onPoll, onDebug, shouldStop } = {}) {
  const processed = new Set();
  for (let i = 0; i < attempts; i += 1) {
    if (shouldStop && shouldStop()) return null;

    let messages = [];
    try {
      messages = await fetchNewMessages();
    } catch { /* 轮询抖动忽略，下轮再取 */ }

    for (const msg of messages) {
      if (!msg?.id || processed.has(msg.id)) continue;
      processed.add(msg.id);
      if (onDebug) {
        try { onDebug({ subject: msg.subject, body: msg.body }); } catch { /* 日志回调异常忽略 */ }
      }
      const code = extractVerificationCode(msg.subject, msg.body);
      if (code) return code;
    }

    if (onPoll) onPoll(i + 1, attempts);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

class GuerrillaMailProvider {
  constructor() {
    this.sid = null;
    this.emailAddress = null;
    this.baselineIds = new Set();
  }

  async api(params) {
    const qs = new URLSearchParams({ lang: 'en', ...params });
    if (this.sid) qs.set('sid_token', this.sid);
    const data = await fetchJson(`https://api.guerrillamail.com/ajax.php?${qs}`);
    if (!data || typeof data !== 'object') throw new Error('guerrillamail 响应为空');
    return data;
  }

  async start() {
    const boot = await this.api({ f: 'get_email_address' });
    if (!boot?.sid_token) throw new Error('guerrillamail 未返回会话');
    this.sid = boot.sid_token;

    const local = randomString(10, CHARS_LOWER);
    const data = await this.api({ f: 'set_email_user', email_user: local });
    const domain = String(boot.email_addr || '').split('@')[1] || 'sharklasers.com';
    this.emailAddress = data?.email_addr || `${local}@${domain}`;

    // 共享地址池：标记会话建立前已存在的邮件，轮询只认之后新到的
    //（防残留垃圾邮件里的 6 位数字被误提取成验证码）
    try {
      const existing = await this.api({ f: 'get_email_list', offset: 0 });
      for (const m of (Array.isArray(existing?.list) ? existing.list : [])) {
        if (m?.mail_id) this.baselineIds.add(String(m.mail_id));
      }
    } catch { /* 基线拉取失败按空处理 */ }
  }

  getEmail() {
    return this.emailAddress;
  }

  async fetchNewMessages() {
    const data = await this.api({ f: 'get_email_list', offset: 0 });
    const list = Array.isArray(data?.list) ? data.list : [];
    const out = [];
    for (const m of list) {
      if (!m?.mail_id) continue;
      if (this.baselineIds.has(String(m.mail_id))) continue;
      let subject = m.mail_subject || '';
      let body = m.mail_excerpt || '';
      try {
        const full = await this.api({ f: 'fetch_email', email_id: String(m.mail_id) });
        subject = full?.mail_subject || subject;
        body = full?.mail_body || body;
      } catch { /* 详情拉取失败仍用列表摘要兜底 */ }
      out.push({ id: String(m.mail_id), subject, body });
    }
    return out;
  }

  async pollVerificationCode(opts) {
    return pollMailForCode(() => this.fetchNewMessages(), opts);
  }
}

const PROVIDERS = [
  { name: 'guerrillamail', create: () => new GuerrillaMailProvider() },
];

class TempMailClient {
  constructor() {
    this.provider = null;
    this.providerName = '';
  }

  async start() {
    const errors = [];
    for (const p of PROVIDERS) {
      try {
        const impl = p.create();
        await impl.start();
        this.provider = impl;
        this.providerName = p.name;
        return;
      } catch (err) {
        errors.push(`${p.name}: ${err.message}`);
      }
    }
    throw new Error(`全部临时邮箱不可用（${errors.join('；')}）`);
  }

  getEmail() {
    return this.provider ? this.provider.getEmail() : null;
  }

  async pollVerificationCode(opts) {
    if (!this.provider) throw new Error('临时邮箱未初始化');
    return this.provider.pollVerificationCode(opts);
  }
}

module.exports = { TempMailClient, extractVerificationCode };
