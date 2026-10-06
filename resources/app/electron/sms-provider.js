
// 接码平台适配层：手机号来源抽象（trae.cn 仅支持 +86 大陆号，探查确认无国际区号下拉）
// 适配器协议: requestNumber() → {orderId, phone}; pollCode(orderId) → code; release(orderId)
// manual  = 在工具界面上手动填号/填码（零成本立即可用）
// http    = 通用 HTTP 模板模式：按平台文档配置买号/取码 URL 与提取正则，可对接任意接码平台

const http = require('http');
const https = require('https');

function httpGetJson(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('接码平台请求超时')); });
    req.on('error', reject);
  });
}

class ManualSmsProvider {
  constructor(askUser) {
    this.askUser = askUser;
    this.phone = null;
  }

  async requestNumber() {
    const phone = await this.askUser('phone', { label: '输入接码手机号（仅支持 +86 大陆号，不带 +86 前缀）' });
    if (!/^1\d{10}$/.test(String(phone).trim())) throw new Error(`手机号格式无效: ${phone}`);
    this.phone = String(phone).trim();
    return { orderId: 'manual', phone: this.phone };
  }

  async pollCode() {
    const code = await this.askUser('code', { label: `输入 ${this.phone} 收到的短信验证码（6位数字）` });
    const digits = String(code || '').replace(/\D/g, '');
    if (!/^\d{4,8}$/.test(digits)) throw new Error(`验证码格式无效: ${code}`);
    return digits;
  }

  async release() { /* no-op */ }
}

// 通用 HTTP 模板：URL 支持 {TOKEN} {ORDER} 占位符，响应用正则提取
// 配置（settings.smsHttp）: {
//   token, numberUrl, pollUrl, releaseUrl?,
//   phoneRegex, orderIdRegex, codeRegex, headers?{key:value}
// }
class HttpTemplateSmsProvider {
  constructor(config, onLog = () => {}) {
    const cfg = config || {};
    if (!cfg.numberUrl || !cfg.pollUrl || !cfg.phoneRegex || !cfg.orderIdRegex || !cfg.codeRegex) {
      throw new Error('接码平台 HTTP 配置不完整（需要 numberUrl/pollUrl/phoneRegex/orderIdRegex/codeRegex）');
    }
    this.cfg = cfg;
    this.onLog = onLog;
  }

  fill(url, order) {
    return url
      .replace(/\{TOKEN\}/g, encodeURIComponent(this.cfg.token || ''))
      .replace(/\{ORDER\}/g, encodeURIComponent(order || ''));
  }

  async fetch(url) {
    const res = await httpGetJson(this.fill(url), this.cfg.headers || {});
    if (res.status >= 400) throw new Error(`接码平台 HTTP ${res.status}: ${res.body.slice(0, 120)}`);
    return res.body;
  }

  async requestNumber() {
    const body = await this.fetch(this.cfg.numberUrl);
    const phone = (body.match(new RegExp(this.cfg.phoneRegex)) || [])[1];
    const orderId = (body.match(new RegExp(this.cfg.orderIdRegex)) || [])[1];
    if (!phone || !orderId) throw new Error(`买号响应解析失败: ${body.slice(0, 150)}`);
    this.onLog(`接码平台取号成功 ${phone}`);
    return { orderId, phone: String(phone).replace(/\D/g, '') };
  }

  async pollCode(orderId) {
    const body = await this.fetch(this.cfg.pollUrl, orderId);
    const code = (body.match(new RegExp(this.cfg.codeRegex)) || [])[1];
    return code ? String(code).replace(/\D/g, '') : null;
  }

  async release(orderId) {
    if (!this.cfg.releaseUrl) return;
    try { await this.fetch(this.cfg.releaseUrl, orderId); } catch { /* 释放失败不致命 */ }
  }
}

// 轮询包装：间隔取码直到拿到或超时
async function pollForCode(provider, orderId, { attempts = 30, intervalMs = 5000, onLog = () => {} } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const code = await provider.pollCode(orderId);
    if (code) return code;
    onLog(`等待短信验证码... (${i + 1}/${attempts})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('等待短信验证码超时');
}

function createSmsProvider(settings, askUser, onLog) {
  if (settings && settings.smsMode === 'http' && settings.smsHttp && settings.smsHttp.numberUrl) {
    return new HttpTemplateSmsProvider(settings.smsHttp, onLog);
  }
  return new ManualSmsProvider(askUser);
}

module.exports = { ManualSmsProvider, HttpTemplateSmsProvider, pollForCode, createSmsProvider };