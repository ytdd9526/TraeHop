
// IDE 同源 OAuth 授权链路（逆向自 TRAE IDE main.js + trae.cn 前端 authorization 组件）：
//   PKCE(S256) → {loginHost}/authorization?auth_from=trae&auth_callback_url=127.0.0.1:17388
//   → 页面渲染 "Log in and open TRAE" 按钮 → 点击后 GetPCAuthCode 签发 AuthCode
//   → 页面跳转回调 /authorize?authCodeInfo=.. → ExchangeToken 换 Token/RefreshToken
// auth_from=trae（IDE_PC 线）：前端授权组件正常渲染；
// auth_from=solo 被前端 blockTTP 硬封（渲染 "Unavailable" 页），不可用
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const { fetchT } = require('./http');

const OAUTH_CLIENT_ID = 'ono9krqynydwx5';
const OAUTH_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken';
const IDE_VERSION = '3.3.100';
const PLUGIN_VERSION = '2.3.83560';
const PLATFORM_CODE = 'IDE_PC';
const CALLBACK_PORT = 17388;

function makePkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// device_id 对齐真实客户端格式（纯数字）；machineId 加随机盐使每个账号指纹独立
function newDeviceIdentity() {
  let digits = '';
  while (digits.length < 16) {
    digits += crypto.randomBytes(8).readBigUInt64BE(0).toString();
  }
  return {
    deviceId: digits.slice(0, 16),
    machineId: crypto.createHash('sha256').update(os.hostname() + crypto.randomBytes(16)).digest('hex').slice(0, 32),
  };
}

function generateDevicePublicKey() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

// 本地授权回调服务器：授权页点击确认后跳转 /authorize?authCodeInfo=..&userInfo=..
class AuthCallbackServer {
  constructor(onLog = () => {}) {
    this.server = null;
    this.port = 0;
    this.onLog = onLog;
    this.pending = null;
    this.received = null;
    this.timer = null;
    this.retried = false;
  }

  _handler() {
    return (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        res.writeHead(200, this.corsHeaders());
        res.end();
        return;
      }
      res.writeHead(200, { ...this.corsHeaders(), 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#111314;color:#eee;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><h3>✅ 授权成功，本窗口可以关闭</h3></body></html>');

      if (url.pathname !== '/authorize' || !this.pending) return;

      const params = Object.fromEntries(url.searchParams.entries());
      const payload = {
        raw: params,
        authCode: null,
        host: params.host || '',
        codeVerifier: params.codeVerifier || '',
        userInfo: null,
      };
      try {
        const info = params.authCodeInfo ? JSON.parse(params.authCodeInfo) : null;
        payload.authCode = info && (info.AuthCode || info.authCode);
      } catch { /* */ }
      try {
        payload.userInfo = params.userInfo ? JSON.parse(params.userInfo) : null;
      } catch { /* */ }

      if (payload.authCode) {
        const { resolve: done } = this.pending;
        this.pending = null;
        this.received = payload;
        done(payload);
      }
    };
  }

  // 固定 17388（官网用此端口探测客户端在线）；被占用时退回随机端口
  start() {
    return new Promise((resolve, reject) => {
      const tryListen = (port) => {
        const server = http.createServer(this._handler());
        server.on('error', (err) => {
          if (this.pending) { this.pending.reject(err); this.pending = null; }
          if (!this.port && !this.retried && port === CALLBACK_PORT && err.code === 'EADDRINUSE') {
            this.retried = true;
            this.onLog(`回调端口 ${CALLBACK_PORT} 被占用，改用随机端口`);
            tryListen(0);
            return;
          }
          if (!this.port) reject(err);
        });
        server.listen(port, '127.0.0.1', () => {
          this.server = server;
          this.port = server.address().port;
          resolve(this.port);
        });
      };
      tryListen(CALLBACK_PORT);
    });
  }

  corsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
  }

  waitForCallback(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.timer = setTimeout(() => {
        if (this.pending) {
          this.pending.reject(new Error('授权回调超时'));
          this.pending = null;
        }
      }, timeoutMs);
    });
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    if (this.pending) { this.pending.reject(new Error('回调服务器已关闭')); this.pending = null; }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// 构造 IDE 同款 authorization 页 URL（参数集对齐真实 TRAE IDE + 抓包固化的可用实现）
// 不带 email：带了会让授权页渲染登录组件并预填邮箱，触发临时邮箱域名风控（at-risk）
function buildAuthorizationUrl(edition, { port, deviceId, machineId, codeChallenge }) {
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'trae',
    login_channel: 'native_ide',
    plugin_version: PLUGIN_VERSION,
    auth_type: 'local',
    client_id: OAUTH_CLIENT_ID,
    redirect: '0',
    login_trace_id: crypto.randomBytes(16).toString('hex'),
    auth_callback_url: `http://127.0.0.1:${port}/authorize`,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: '',
    x_device_type: 'Windows',
    x_os_version: os.release(),
    x_env: '',
    x_app_version: IDE_VERSION,
    x_app_type: 'stable',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    channel_name: 'common',
  });
  return `${edition.loginHost}/authorization?${params.toString()}`;
}

async function exchangeTokenByAuthCode(apiBase, { authCode, codeVerifier, deviceId, machineId, devicePublicKey }) {
  const body = {
    ClientID: OAUTH_CLIENT_ID,
    AuthCode: authCode,
    CodeVerifier: codeVerifier,
    DeviceInfo: {
      DeviceID: deviceId,
      MachineID: machineId,
      PlatformCode: PLATFORM_CODE,
      DeviceType: 'PC',
      DeviceName: os.hostname(),
      DeviceModel: '',
      ClientVersion: IDE_VERSION,
      DevicePublicKey: devicePublicKey,
      DeviceBrand: '',
      DeviceCPU: '',
      OSInfo: 'Windows',
      OSVersion: os.release(),
    },
    IDEVersion: IDE_VERSION,
  };
  const res = await fetchT(`${apiBase}${EXCHANGE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      Origin: 'app://trae',
      'User-Agent': `Trae/${IDE_VERSION}`,
      'x-device-id': deviceId,
      'x-app-id': OAUTH_APP_ID,
      'x-platform-code': PLATFORM_CODE,
      'x-cloudide-token': '',
    },
    body: JSON.stringify(body),
  }, 20000);
  const data = await res.json().catch(() => null);
  const errCode = data && data.ResponseMetadata && data.ResponseMetadata.Error;
  if (errCode && errCode.Code && String(errCode.Code) !== '0') {
    throw new Error(`ExchangeToken code=${errCode.Code} ${errCode.Message || ''}`);
  }
  if (!res.ok || !data) {
    const err = new Error(`ExchangeToken ${res.status} ${JSON.stringify(data || {}).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const r = data.Result || data.result || data;
  const token = r.Token || r.token || r.AccessToken || r.access_token;
  if (!token) throw new Error(`ExchangeToken 响应无 Token: ${JSON.stringify(data).slice(0, 200)}`);
  return {
    token,
    refreshToken: r.RefreshToken || r.refresh_token || r.refreshToken || '',
    expiredAt: r.ExpiredAt || r.expiredAt || r.TokenExpireAt || '',
    apiBase,
    raw: data,
  };
}

// 回调 host（页面运行时 API 集群）优先，失败再依次尝试各配置 base
async function exchangeTokenWithFallback(edition, payload, onLog = () => {}, callbackHost = '') {
  const bases = [];
  if (callbackHost) {
    const host = callbackHost.trim().replace(/\/+$/, '');
    if (host) bases.push(/^https?:\/\//.test(host) ? host : `https://${host}`);
  }
  for (const base of edition.apiBases) {
    if (!bases.includes(base)) bases.push(base);
  }
  let lastErr = null;
  for (const base of bases) {
    try {
      const result = await exchangeTokenByAuthCode(base, payload);
      onLog(`ExchangeToken 成功 (${base})`);
      return result;
    } catch (err) {
      lastErr = err;
      onLog(`ExchangeToken ${base} 失败: ${err.message}`);
    }
  }
  throw lastErr || new Error('ExchangeToken 全部失败');
}

module.exports = {
  OAUTH_CLIENT_ID,
  makePkce,
  newDeviceIdentity,
  generateDevicePublicKey,
  AuthCallbackServer,
  buildAuthorizationUrl,
  exchangeTokenByAuthCode,
  exchangeTokenWithFallback,
};