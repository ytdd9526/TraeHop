const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session, app } = require('electron');
const { TempMailClient } = require('./temp-mail');
const { getUserToken, claimBirthdayBonus } = require('./trae-api');
const accountStore = require('./account-store');
const { getEdition, normalizeEdition } = require('./edition-config');
const {
  makePkce,
  newDeviceIdentity,
  generateDevicePublicKey,
  AuthCallbackServer,
  buildAuthorizationUrl,
  exchangeTokenWithFallback,
} = require('./ide-oauth');
const { createSmsProvider, pollForCode } = require('./sms-provider');

const ACCOUNT_SETTING_URL = 'https://www.trae.ai/account-setting#account';
const CHROME_VERSIONS = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0', '126.0.0.0', '127.0.0.0', '128.0.0.0', '129.0.0.0', '130.0.0.0', '131.0.0.0'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function randomUA() {
  const v = CHROME_VERSIONS[crypto.randomBytes(1)[0] % CHROME_VERSIONS.length];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

function generatePassword(length = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const buf = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[buf[i] % chars.length];
  return out;
}

const JS_FIND_INPUT = `(function (patterns) {
  const inputs = [...document.querySelectorAll('input')];
  for (const source of patterns) {
    const rx = new RegExp(source, 'i');
    const idx = inputs.findIndex((el) =>
      rx.test(el.type) || rx.test(el.placeholder || '') || rx.test(el.getAttribute('aria-label') || '') || rx.test(el.name || '')
    );
    if (idx >= 0) {
      const r = inputs[idx].getBoundingClientRect();
      if (r.width < 2) continue;
      return { idx, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
  }
  return null;
})(%PATTERNS%)`;

const JS_LOCATE_BUTTON = `(function (pattern, pickIndex) {
  const rx = new RegExp(pattern, 'i');
  const directText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  let hits = [...document.querySelectorAll('button, [role="button"], span, div, a')].filter((el) => rx.test(directText(el)));
  if (!hits.length) hits = [...document.querySelectorAll('button, [role="button"], div, span, a')].filter((el) => rx.test((el.innerText || '').trim()));
  if (!hits.length) return null;
  const idx = pickIndex < 0 ? hits.length + pickIndex : pickIndex;
  const target = idx >= 0 && idx < hits.length ? hits[idx] : hits[0];
  const r = target.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})(%PATTERN%, %PICK_INDEX%)`;

// 表单提交按钮：form 内最后一个按钮，或 button[type=submit]，避免按文本定位点到导航栏同名元素
const JS_LOCATE_FORM_SUBMIT = `(function () {
  let btn = null;
  for (const f of document.querySelectorAll('form')) {
    const cands = [...f.querySelectorAll('button, [role="button"]')].filter((b) => !b.disabled);
    if (cands.length) { btn = cands[cands.length - 1]; break; }
  }
  if (!btn) {
    const subs = [...document.querySelectorAll('button[type="submit"]')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    btn = subs[subs.length - 1];
  }
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

const JS_INPUT_VALUE_AT = `(document.querySelectorAll('input')[%IDX%] && document.querySelectorAll('input')[%IDX%].value) || ''`;

// 只匹配真实按钮控件（button/[role=button]/submit），避免宽松匹配命中
// "Continue with GitHub" 这类 OAuth 入口（登录页 Continue/Log in 定位专用）
const JS_LOCATE_BUTTON_STRICT = `(function (pattern, pickIndex) {
  const rx = new RegExp(pattern, 'i');
  const hits = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter((el) =>
    rx.test((el.innerText || el.value || '').trim()));
  if (!hits.length) return null;
  const target = hits.length > 1 && pickIndex < hits.length ? hits[pickIndex] : hits[0];
  const r = target.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})(%PATTERN%, %PICK_INDEX%)`;

// 兜底用 DOM 赋值（部分字段真实键盘管线写不进去时的备选）
const JS_FILL_BY_IDX = `(function (idx, value) {
  const el = document.querySelectorAll('input')[idx];
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(%IDX%, %VALUE%)`;

const JS_INPUT_DEBUG = `(function () {
  const all = [...document.querySelectorAll('input')].map((el, i) => {
    const r = el.getBoundingClientRect();
    return i + ':' + el.type + ':' + (el.placeholder || '') + ':' + JSON.stringify(el.value).slice(0, 40) + ':w' + Math.round(r.width);
  });
  const ae = document.activeElement;
  return JSON.stringify({ ae: ae ? (ae.tagName + ':' + (ae.placeholder || '') + ':' + JSON.stringify(ae.value)) : '', all: all.join(' | ') });
})()`;

const JS_ERROR_TEXT = `(function () {
  const el = document.querySelector('.error-message');
  return el ? el.innerText.trim() : '';
})()`;

// 发码按钮状态：倒计时/禁用/验证码输入框出现 = 前端已受理发码请求（接口路径可能改名，
// 不能只靠 URL 正则判断"请求发出"，页面状态是最可靠的信号）
const JS_SENDCODE_STATE = `(function () {
  for (const b of [...document.querySelectorAll('button, [role="button"]')]) {
    const t = (b.innerText || '').trim();
    const r = b.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (/\\b(\\d{1,3})\\s*s\\b|resend|重新.*(?:\\d|秒)|再.*(?:\\d|秒)/i.test(t)) return 'countdown:' + t.slice(0, 40);
    if (b.disabled && /code|send|验证|发送/i.test(t)) return 'disabled:' + t.slice(0, 40);
  }
  const hasCodeInput = [...document.querySelectorAll('input')].some((el) => {
    const p = (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.name || '');
    return /verif|code|验证码/i.test(p);
  });
  if (hasCodeInput) return 'verify-input';
  return '';
})()`;

// 授权页状态文本：用于死路检测（地区屏蔽页 / 失败页）与按钮就绪判断
const JS_AUTH_PAGE_TEXT = `(function () {
  var t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  return t.slice(0, 260);
})()`;

const JS_DETECT_CAPTCHA = `(function () {
  const ifr = [...document.querySelectorAll('iframe')].find((el) =>
    /captcha/i.test(el.src || '') || /captcha/i.test(el.id || '') || /captcha/i.test(el.className || ''));
  if (ifr) { const r = ifr.getBoundingClientRect(); if (r.width > 50 && r.height > 40) return { kind: 'iframe', w: Math.round(r.width), h: Math.round(r.height), src: (ifr.src || '').slice(0, 160) }; }
  const box = [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i]')].find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 120 && r.height > 90;
  });
  if (box) { const r = box.getBoundingClientRect(); return { kind: 'box', w: Math.round(r.width), h: Math.round(r.height), src: '' }; }
  return null;
})()`;

function buildScript(template, replacements) {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(key).join(value);
  }
  return out;
}

function patternsLiteral(patterns) {
  return JSON.stringify(patterns);
}

async function evalOnPage(win, script) {
  return win.webContents.executeJavaScript(script, true).catch(() => null);
}

async function waitForPageState(win, checkScript, { attempts = 30, intervalMs = 500, shouldStop } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (shouldStop()) return null;
    const result = await evalOnPage(win, checkScript);
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function findInputScript(patterns) {
  return buildScript(JS_FIND_INPUT, { '%PATTERNS%': patternsLiteral(patterns) });
}

// 走 Chromium 真实输入管线（isTrusted=true），官网前端会丢弃 DOM 派生的合成点击
async function humanMoveTo(win, x, y) {
  const wc = win.webContents;
  const sx = Math.max(0, x - 40 - Math.floor(Math.random() * 50));
  const sy = Math.max(0, y - 30 - Math.floor(Math.random() * 40));
  const steps = 5 + Math.floor(Math.random() * 4);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const nx = Math.round(sx + (x - sx) * t + (Math.random() * 3 - 1.5));
    const ny = Math.round(sy + (y - sy) * t + (Math.random() * 3 - 1.5));
    wc.sendInputEvent({ type: 'mouseMove', x: nx, y: ny });
    await sleep(25 + Math.floor(Math.random() * 45));
  }
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  await sleep(40 + Math.floor(Math.random() * 80));
}

async function clickAt(win, x, y) {
  try {
    if (!win.isFocused()) {
      win.show();
      win.focus();
    }
  } catch { /* */ }
  const wc = win.webContents;
  await humanMoveTo(win, x, y);
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(50 + Math.floor(Math.random() * 70));
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(120);
}

// 页面加载后的拟人浏览活动，降低字节风控的行为风险分
async function simulateHumanBrowsing(win) {
  const wc = win.webContents;
  for (let i = 0; i < 4; i += 1) {
    wc.sendInputEvent({
      type: 'mouseMove',
      x: 100 + Math.floor(Math.random() * 700),
      y: 100 + Math.floor(Math.random() * 500),
    });
    await sleep(150 + Math.floor(Math.random() * 200));
  }
  wc.sendInputEvent({ type: 'mouseWheel', x: 500, y: 400, deltaY: 90, deltaMode: 0 });
  await sleep(300);
  wc.sendInputEvent({ type: 'mouseWheel', x: 500, y: 300, deltaY: -60, deltaMode: 0 });
  await sleep(300);
}

// CDP 网络监视：常驻挂载（对页面 JS 不可见，不触发自动化检测），
// 测试模式打印 passport/captcha 响应体；waitResponse 供 GetUserToken 拦截使用
function attachNetMonitor(win, onLog) {
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch (err) {
    onLog(`NET 监视附加失败：${err.message}`);
    return { waitResponse: () => Promise.resolve(null) };
  }
  const tracked = new Map();
  const waiters = [];
  dbg.on('message', (_event, method, params) => {
    if (method === 'Network.responseReceived') {
      const url = (params.response && params.response.url) || '';
      const wantLog = process.env.TRAEHOP_TEST_REGISTER === '1' && /passport\/web|captcha|authorization|oauth|pcauthcode/i.test(url);
      const hasWaiter = waiters.some((w) => w.pattern.test(url));
      if (wantLog || hasWaiter) {
        tracked.set(params.requestId, { url, status: params.response.status, wantLog });
      }
    }
    if (method === 'Network.loadingFinished' && tracked.has(params.requestId)) {
      const info = tracked.get(params.requestId);
      tracked.delete(params.requestId);
      dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then((res) => {
        const body = res && res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : (res && res.body) || '';
        if (info.wantLog) {
          onLog(`RESP ${info.status} ${info.url.replace(/^[a-z]+:\/\/[^/]+/, '').slice(0, 130)} BODY ${String(body).slice(0, 800)}`);
        }
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (waiters[i].pattern.test(info.url)) {
            const w = waiters.splice(i, 1)[0];
            clearTimeout(w.timer);
            w.resolve({ status: info.status, url: info.url, body: String(body) });
          }
        }
      }).catch(() => {});
    }
  });
  dbg.sendCommand('Network.enable').catch(() => {});
  return {
    waitResponse(pattern, timeoutMs = 25000) {
      return new Promise((resolve) => {
        const entry = { pattern, resolve, timer: null };
        entry.timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push(entry);
      });
    },
  };
}

// Electron loadURL 无超时：页面因风控/网络 pending 时永久挂死且零日志（09:42 授权页实证）
// 超时后不再等待继续流程，后续 evalOnPage 在已渲染内容上照常工作
async function loadURLWithTimeout(win, url, ms, onLog = () => {}) {
  let loadError = '';
  let timedOut = false;
  let timer = null;
  const load = win.loadURL(url).catch((err) => { loadError = (err && err.message) || String(err); });
  try {
    await Promise.race([
      load,
      new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (loadError) throw new Error(`页面加载失败：${loadError}`);
  if (timedOut) onLog(`⚠️ 页面加载超 ${Math.round(ms / 1000)}s 未完成，不再等待，继续流程...`);
}

// 字节风控弹滑块时：置前窗口等待人工完成（150s），期间测试模式截屏留档
async function handleCaptcha(win, onLog, shouldStop) {
  const appeared = await waitForPageState(win, JS_DETECT_CAPTCHA, { attempts: 30, intervalMs: 500, shouldStop });
  if (!appeared) return false;
  onLog(`🧩 检测到验证码（${appeared.kind} ${appeared.w}x${appeared.h}），窗口已置前：请手动拖动滑块`);
  try { win.show(); win.focus(); win.moveTop(); } catch { /* */ }
  if (process.env.TRAEHOP_TEST_REGISTER === '1') {
    try {
      await sleep(1500);
      const shot = await win.webContents.capturePage();
      fs.writeFileSync('D:\\下载\\TraeHop\\captcha-shot.png', shot.toPNG());
      onLog('已保存验证码截图 captcha-shot.png');
    } catch { /* */ }
  }
  for (let waited = 0; waited < 150000; waited += 1000) {
    if (shouldStop()) return true;
    await sleep(1000);
    const still = await evalOnPage(win, JS_DETECT_CAPTCHA);
    if (!still) { onLog('✅ 验证码已通过，继续流程'); return true; }
    if (waited > 0 && waited % 15000 === 0) onLog(`等待滑块完成... (${waited / 1000}s)`);
  }
  onLog('⚠️ 等待滑块超时（150s），继续尝试');
  return true;
}

async function clickButtonByText(win, pattern, pickIndex = 0) {
  const pos = await evalOnPage(win, buildScript(JS_LOCATE_BUTTON, {
    '%PATTERN%': JSON.stringify(pattern),
    '%PICK_INDEX%': String(pickIndex),
  }));
  if (!pos) return false;
  await clickAt(win, pos.x, pos.y);
  return true;
}

async function clickButtonStrict(win, pattern, pickIndex = 0) {
  const pos = await evalOnPage(win, buildScript(JS_LOCATE_BUTTON_STRICT, {
    '%PATTERN%': JSON.stringify(pattern),
    '%PICK_INDEX%': String(pickIndex),
  }));
  if (!pos) return false;
  await clickAt(win, pos.x, pos.y);
  return true;
}

// 定位表单提交按钮并点击
async function clickFormSubmit(win) {
  const pos = await evalOnPage(win, JS_LOCATE_FORM_SUBMIT);
  if (!pos) return false;
  await clickAt(win, pos.x, pos.y);
  return true;
}

// 真实键盘管线填写：点击聚焦(isTrusted) → Ctrl+A 清空 → 逐字符 insertText(拟人节奏) → 重定位校验
// 失败时 DOM 赋值兜底并输出诊断；DOM 直接赋值可能被前端倒计时重渲染清掉，键盘管线是首选
async function typeHumanInto(win, patterns, value, shouldStop, onLog = () => {}) {
  const info = await waitForPageState(win, findInputScript(patterns), { attempts: 20, intervalMs: 500, shouldStop });
  if (!info) return false;
  await clickAt(win, info.x, info.y);
  await sleep(150 + Math.floor(Math.random() * 150));

  const focusTag = await evalOnPage(win, `(document.activeElement && document.activeElement.tagName) || ''`);
  if (focusTag !== 'INPUT' && focusTag !== 'TEXTAREA') {
    await clickAt(win, info.x + randomInt(-4, 4), info.y + randomInt(-3, 3));
    await sleep(200);
  }

  const wc = win.webContents;
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] });
  await sleep(60);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  await sleep(80);

  for (const ch of String(value)) {
    wc.insertText(ch);
    await sleep(55 + Math.floor(Math.random() * 85));
  }
  await sleep(200);

  let after = await evalOnPage(win, findInputScript(patterns));
  if (!after) return false;
  let current = await evalOnPage(win, buildScript(JS_INPUT_VALUE_AT, { '%IDX%': String(after.idx) }));
  if (current !== value) {
    const dbg = await evalOnPage(win, JS_INPUT_DEBUG);
    onLog(`TYPEFAIL(键盘) want=${JSON.stringify(value)} idx=${after.idx} got=${JSON.stringify(current)} ${dbg}`);
    await evalOnPage(win, buildScript(JS_FILL_BY_IDX, { '%IDX%': String(after.idx), '%VALUE%': JSON.stringify(value) }));
    await sleep(150);
    after = await evalOnPage(win, findInputScript(patterns));
    if (!after) return false;
    current = await evalOnPage(win, buildScript(JS_INPUT_VALUE_AT, { '%IDX%': String(after.idx) }));
    if (current !== value) {
      const dbg2 = await evalOnPage(win, JS_INPUT_DEBUG);
      onLog(`TYPEFAIL(DOM兜底) want=${JSON.stringify(value)} idx=${after.idx} got=${JSON.stringify(current)} ${dbg2}`);
      return false;
    }
  }
  return true;
}

// 自愈校验：前端重渲染会把已填字段清空（实测偶发），点击关键按钮前先确认值还在，
// 丢了就用拟人管线重填
async function ensureFilled(win, patterns, value, shouldStop, onLog) {
  const info = await evalOnPage(win, findInputScript(patterns));
  if (!info) return false;
  const current = await evalOnPage(win, buildScript(JS_INPUT_VALUE_AT, { '%IDX%': String(info.idx) }));
  if (current === value) return true;
  onLog(`字段[${patterns[0]}]值丢失(${JSON.stringify(current)})，重新填写...`);
  return typeHumanInto(win, patterns, value, shouldStop, onLog);
}

async function exportCookieString(ses) {
  const cookies = await ses.cookies.get({});
  const relevant = cookies.filter((c) => /trae/i.test(c.domain || ''));
  return relevant.map((c) => `${c.name}=${c.value}`).join('; ');
}

// 登录态判定：URL 离开登录/注册页，或字节系会话 Cookie（sessionid 等）落在版本对应域；
// verify=true 时 Cookie 命中须窗口内 GetUserToken 实证——游客也种 sessionid，
// 光看 Cookie 会把被风控拦截的注册误判成成功（at-risk 提交失败页面不跳转但 sessionid 已落地）
async function waitForLoginLanded(win, ses, { stopPath, cookiePattern, attempts = 60, onLog, shouldStop, verify = false }) {
  let emptySessionStreak = 0;
  for (let i = 0; i < attempts; i += 1) {
    if (shouldStop()) return false;
    await sleep(500);
    if (!win.webContents.getURL().includes(stopPath)) {
      onLog('✅ 页面已跳转，登录态落地');
      return true;
    }
    const cookies = await ses.cookies.get({});
    if (cookies.some((c) => /^(sessionid|sid_guard|passport_auth_status)$/i.test(c.name) && cookiePattern.test(c.domain || ''))) {
      if (!verify) {
        onLog('官网未跳转，但登录 Cookie 已落地');
        return true;
      }
      const token = await fetchUserTokenInPage(win, onLog);
      if (token) {
        onLog('✅ 登录 Cookie 已落地，窗口内 Token 实证通过');
        return true;
      }
      emptySessionStreak += 1;
      // 连续 8 次 session empty = 注册实际失败（游客 sessionid 迷惑人），dump 页面快速失败
      if (emptySessionStreak >= 8) {
        const dump = await evalOnPage(win, `(function () {
          const err = document.querySelector('.error-message')?.innerText || '';
          const forms = [...document.forms].length;
          return JSON.stringify({ url: location.href, err: err.slice(0, 200), forms, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) });
        })()`);
        onLog(`LOGIN-FAIL-DUMP ${dump || '页面无响应'}`);
        onLog('连续 8 次 Token 实证失败（注册未真正成功），不再等待');
        return false;
      }
      onLog('Cookie 已落地但 Token 实证未通过（疑似游客 sessionid），继续等待…');
    } else {
      emptySessionStreak = 0;
    }
    const errText = await evalOnPage(win, JS_ERROR_TEXT);
    if (errText && /invalid|wrong|error|fail|错误|失败|无效/i.test(errText)) throw new Error(`官网报错：${errText}`);
  }
  return false;
}

function parseSiteTokenBody(body) {
  try {
    const d = JSON.parse(body);
    const r = (d && (d.Result || d.result)) || {};
    const token = r.Token || r.token;
    if (!token) return null;
    return {
      token,
      expiredAt: r.ExpiredAt || r.expiredAt || r.expired_at || '',
      userId: String(r.UserID || r.user_id || r.userId || ''),
      tenantId: String(r.TenantID || r.tenant_id || r.tenantId || ''),
    };
  } catch {
    return null;
  }
}

// 注册窗口同源直调 GetUserToken：相对路径 fetch 自动携带窗口当前域的登录 Cookie，
// 免导出丢字段/域错配，比外部 fetch 更可靠；cn 站点域若无此端点返回 null 自然落到下一兜底
const JS_FETCH_USER_TOKEN_IN_PAGE = `(async function () {
  try {
    const r = await fetch('/cloudide/api/v3/common/GetUserToken', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = await r.text();
    return JSON.stringify({ status: r.status, body: body.slice(0, 2000) });
  } catch (e) { return JSON.stringify({ status: 0, body: String((e && e.message) || e) }); }
})()`;

async function fetchUserTokenInPage(win, onLog = null) {
  const raw = await evalOnPage(win, JS_FETCH_USER_TOKEN_IN_PAGE);
  if (!raw) return null;
  try {
    const { status, body } = JSON.parse(raw);
    if (status === 200) {
      const parsed = parseSiteTokenBody(body);
      if (parsed && parsed.token) return parsed;
    }
    if (onLog) onLog(`窗口内 GetUserToken ${status}：${String(body).slice(0, 100)}`);
  } catch { /* */ }
  return null;
}

// account-setting 页会由站点前端自己发 GetUserToken，新开隐藏窗口 + CDP 拦截响应体
//（与 login-preload 拦截等价，但不依赖 preload，窗口隔离配置不受影响）；
// 不复用注册窗口——授权页残留的协议跳转/自关行为会让 loadURL 瞬间 ERR_FAILED（09:58 实测）
async function captureSiteToken(ses, onLog) {
  const win = new BrowserWindow({
    show: false, width: 900, height: 700, backgroundColor: '#ffffff',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  try {
    const netMonitor = attachNetMonitor(win, onLog);
    const pending = netMonitor.waitResponse(/GetUserToken/i, 25000);
    onLog('新开隐藏窗口访问账号设置页，拦截站点 User Token...');
    await loadURLWithTimeout(win, ACCOUNT_SETTING_URL, 25000, onLog);
    const resp = await pending;
    if (!resp) return null;
    onLog(`站点 GetUserToken ${resp.status} ${resp.url.replace(/^[a-z]+:\/\/[^/]+/, '').slice(0, 80)}`);
    if (process.env.TRAEHOP_TEST_REGISTER === '1') {
      try { fs.writeFileSync('D:\\下载\\TraeHop\\site-token-resp.json', resp.body); } catch { /* */ }
    }
    return parseSiteTokenBody(resp.body);
  } finally {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* */ }
  }
}

// 注册窗口共用准备：独立 session（隔离 Cookie/指纹）+ sec-ch-ua 伪装 + 请求确认监听 + 可见窗口
// fired: {emailRegister, emailSendCode, phoneSendCode, phoneLogin} 供请求确认
async function createRegisterWindow(options, edition, onLog, shouldStop) {
  const ses = session.fromPartition(`register-${crypto.randomUUID()}`, { cache: true });
  if (options.proxy) {
    await ses.setProxy({ proxyRules: options.proxy });
    onLog(`🌐 走代理：${options.proxy}`);
  }
  const ua = randomUA();
  ses.setUserAgent(ua);
  // 伪装 Chrome client hints：Electron 默认暴露 "Chromium" 指纹，字节风控直接识别
  const uaMajor = (ua.match(/Chrome\/(\d+)/) || [])[1] || '131';
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const headers = details.requestHeaders;
    const setHeader = (name, value) => {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
      headers[key || name] = value;
    };
    setHeader('sec-ch-ua', `"Chromium";v="${uaMajor}", "Not_A Brand";v="24", "Google Chrome";v="${uaMajor}"`);
    setHeader('sec-ch-ua-mobile', '?0');
    setHeader('sec-ch-ua-platform', '"Windows"');
    cb({ requestHeaders: headers });
  });

  const fired = {};
  // 极速加载：trae/风控域全放行，第三方 image/font/media 直接取消
  //（对齐 TraeAccountRegister 的资源拦截策略，页面只保留功能性请求，渲染负载大降）
  const AUX_RESOURCE_TYPES = new Set(['image', 'font', 'media']);
  const CORE_URL_RX = /trae\.(ai|cn)|captcha|verify|risk|bytedance|volc|snssdk|secsdk|tiktok/i;
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    if (/passport\/web\/email\/register/i.test(d.url)) fired.emailRegister = true;
    if (/passport\/web\/email\/(send[_-]?code|verify[_-]?code)|email[_-]?(send|verify)[_-]?code|send[_-]?verif/i.test(d.url)) fired.emailSendCode = true;
    if (/send_?sms|phone[^]*?send_?code|sms[^]*?send_?code/i.test(d.url)) fired.phoneSendCode = true;
    if (/passport\/web\/(phone|sms)[^]*?login|passport\/web\/.+?verify_login/i.test(d.url)) fired.phoneLogin = true;
    if (process.env.TRAEHOP_TEST_REGISTER === '1' && /passport|captcha|send_code|register|login|oauth|pcauth/i.test(d.url)) {
      onLog(`NET ${d.method} ${d.url.slice(0, 150)}`);
    }
    if (AUX_RESOURCE_TYPES.has(d.resourceType) && !CORE_URL_RX.test(d.url)) {
      cb({ cancel: true });
      return;
    }
    cb({});
  });

  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 780,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setAudioMuted(true);
  win.setTitle(`鬼鬼聚合 · ${edition.label}自动注册中，请勿操作`);
  // 真实可见窗口：字节风控要求 document.hasFocus()=true（真人环境特征），离屏/隐藏窗口必弹验证码
  win.show();
  win.focus();
  try { win.moveTop(); } catch { /* */ }
  const netMonitor = attachNetMonitor(win, onLog);
  if (process.env.TRAEHOP_TEST_REGISTER === '1') onLog('（测试模式）');
  return { win, ses, netMonitor, fired };
}

// INTL：邮箱注册 + 站点登录，返回 { email, password }
async function registerIntlFlow(win, ses, fired, netMonitor, options, onLog, shouldStop) {
  const edition = getEdition('intl');
  const mail = new TempMailClient();
  const password = generatePassword();

  // mail.tm 免费服务偶发抖动，创建失败直接重试（间隔递增）
  let mailReady = false;
  for (let attempt = 0; attempt < 3 && !mailReady; attempt += 1) {
    if (shouldStop()) throw new Error('用户取消');
    try {
      await mail.start();
      mailReady = true;
    } catch (err) {
      if (attempt === 2) throw new Error(`临时邮箱创建失败：${err.message}`);
      onLog(`临时邮箱服务异常(${err.message})，${5 * (attempt + 1)}s 后重试...`);
      await sleep(5000 * (attempt + 1));
    }
  }
  const email = mail.getEmail();
  onLog(`📮 生成临时邮箱：${email}`);

  await loadURLWithTimeout(win, edition.signupUrl, 30000, onLog);
  onLog('已打开注册页，模拟人类浏览行为...');
  await simulateHumanBrowsing(win);

  const emailInput = await waitForPageState(win, findInputScript(['^email$']), { attempts: 20, intervalMs: 500, shouldStop });
  if (!emailInput) throw new Error('找不到邮箱输入框（页面改版？）');
  if (!(await typeHumanInto(win, ['^email$'], email, shouldStop, onLog))) throw new Error('邮箱填写失败');

  onLog('请求发送验证码...');
  let codeRequested = false;
  // 预检：页面可能已处于等待验证码状态（上一轮实际发码成功但检测失败），避免重复发码
  const preState = await evalOnPage(win, JS_SENDCODE_STATE);
  if (preState) {
    codeRequested = true;
    onLog(`发码请求已确认（页面预检 ${preState}）`);
  }
  for (let attempt = 0; attempt < 3 && !codeRequested; attempt += 1) {
    if (shouldStop()) throw new Error('用户取消');
    if (!(await ensureFilled(win, ['^email$'], email, shouldStop, onLog))) throw new Error('邮箱字段找回失败');
    fired.emailSendCode = false;
    // CDP 响应等待：接口路径可能改名，正则放宽到 send/verify+code 特征
    const respPending = netMonitor.waitResponse(/send[_-]?code|verify[_-]?code|email[_-]?(send|verify)|sms[_-]?code/i, 20000);
    const clicked = await clickButtonByText(win, 'send\\s*code', 0);
    if (!clicked) {
      if (attempt === 0) throw new Error('找不到 Send Code 按钮');
      codeRequested = true;
      break;
    }
    // 三路信号：URL 正则标记 / CDP 响应体 / 页面倒计时+验证码框（页面状态最可靠）
    for (let i = 0; i < 24; i += 1) {
      await sleep(500);
      if (fired.emailSendCode) { codeRequested = true; break; }
      const resp = await Promise.race([respPending, Promise.resolve(null)]);
      if (resp) {
        // 响应体明确报错（如风控拒绝）时不确认成功，等页面状态走重试
        const errBody = /"error"\s*:|"success"\s*:\s*false|"ok"\s*:\s*false/i.test(resp.body || '');
        if (!errBody) {
          codeRequested = true;
          onLog(`发码请求已确认（CDP 响应 HTTP ${resp.status}）`);
          break;
        }
        onLog(`发码接口返回业务错误（HTTP ${resp.status} ${String(resp.body).slice(0, 120)}），等待页面状态...`);
      }
      if (i % 4 === 3) {
        const st = await evalOnPage(win, JS_SENDCODE_STATE);
        if (st) {
          codeRequested = true;
          onLog(`发码请求已确认（页面 ${st}）`);
          break;
        }
      }
    }
    if (!codeRequested) onLog(`发码请求未发出，重试点击 Send Code (${attempt + 1}/3)...`);
  }
  if (!codeRequested) {
    const dump = await evalOnPage(win, `(function () {
      const btns = [...document.querySelectorAll('button, [role="button"]')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 12);
      const inputs = [...document.querySelectorAll('input')].map((el) => el.type + ':' + (el.placeholder || '') + ':' + JSON.stringify(el.value).slice(0, 30)).slice(0, 8);
      return JSON.stringify({ url: location.href, btns, inputs, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) });
    })()`);
    onLog(`SENDCODE-DUMP ${dump || '页面无响应'}`);
    throw new Error('Send Code 点击后请求未发出');
  }
  onLog('发码请求已确认，等待风控判定（可能弹滑块）...');
  await handleCaptcha(win, onLog, shouldStop);

  let code = null;
  for (let round = 1; round <= 2 && !code; round += 1) {
    code = await mail.pollVerificationCode({
      attempts: 9,
      intervalMs: 5000,
      shouldStop,
      onPoll: (i, total) => {
        if (i % 3 === 0 || i === total) onLog(`等待验证码邮件... (${i}/${total} · 第${round}轮)`);
      },
      onDebug: (m) => {
        onLog(`邮件原文: subject=${JSON.stringify(m.subject)} body头=${JSON.stringify(String(m.body).slice(0, 260))}`);
        if (process.env.TRAEHOP_TEST_REGISTER === '1') {
          try { fs.writeFileSync('D:\\下载\\TraeHop\\mail-body.html', String(m.body)); } catch { /* */ }
        }
      },
    });
    if (code) break;
    if (round === 1) {
      onLog('邮件未到，再点一次 Send Code 后继续等待...');
      await clickButtonByText(win, 'send\\s*code|re\\s*send', 0);
      await handleCaptcha(win, onLog, shouldStop);
    }
  }
  if (!code) throw new Error('90 秒内未收到验证码');
  onLog(`✉️ 收到验证码：${code}`);

  if (!(await typeHumanInto(win, ['verification'], code, shouldStop, onLog))) throw new Error('验证码填写失败');
  if (!(await typeHumanInto(win, ['^password$'], password, shouldStop, onLog))) throw new Error('密码填写失败');

  onLog('点击 Sign Up 提交注册...');
  let requestSeen = false;
  let redirected = false;
  let registerResp = null; // { status, body, error }  注册接口真实响应
  const REGISTER_RX = /register_verify_login|passport\/web\/email\/register/i;

  for (let attempt = 0; attempt < 4 && !requestSeen && !redirected && !registerResp; attempt += 1) {
    if (shouldStop()) throw new Error('用户取消');
    await ensureFilled(win, ['^email$'], email, shouldStop, onLog);
    await ensureFilled(win, ['verification'], code, shouldStop, onLog);
    await ensureFilled(win, ['^password$'], password, shouldStop, onLog);
    fired.emailRegister = false;
    // 点击前就挂上 CDP 响应等待——注册接口返回即捕获响应体（成功/失败都能拿到）
    const respPending = netMonitor.waitResponse(REGISTER_RX, 20000);

    let clicked = false;
    if (attempt === 0) {
      clicked = await clickFormSubmit(win);
      if (!clicked) clicked = await clickButtonByText(win, '^sign\\s*up', 1);
    } else if (attempt === 1) {
      clicked = await clickButtonByText(win, '^sign\\s*up', 1);
    } else if (attempt === 2) {
      // 键盘提交：聚焦密码框回车触发表单 submit，避开文本定位误点导航链接
      const info = await evalOnPage(win, findInputScript(['^password$']));
      if (info) {
        await clickAt(win, info.x, info.y);
        await sleep(200);
        const wc0 = win.webContents;
        wc0.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        wc0.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        clicked = true;
      }
    } else {
      clicked = await clickButtonByText(win, 'sign\\s*up|create\\s*account|register', 0);
    }
    if (!clicked) {
      onLog('未定位到 Sign Up 元素，稍后重试...');
      await sleep(2000);
      continue;
    }
    // 每次点击后四路信号并行：CDP 响应体 / URL 跳转 / 滑块 / 报错横幅
    //（11:21 实测提交后 GetUserToken 20310 session empty = 注册实际失败但旧代码只看请求发没发，死循环）
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !registerResp && !redirected) {
      await sleep(500);
      if (!win.webContents.getURL().includes('/sign-up')) { redirected = true; break; }
      // CDP 响应已到：无论成功失败都先记下来，再决定下一步
      const resp = await Promise.race([respPending, Promise.resolve(null)]);
      if (resp) {
        registerResp = resp;
        requestSeen = true;
        break;
      }
      if (fired.emailRegister) requestSeen = true;
      // 每 2s 检查一次滑块 / 报错 / at-risk 弹窗
      const elapsed = Date.now() - (deadline - 20000);
      if (elapsed % 2000 < 500) {
        const captcha = await evalOnPage(win, JS_DETECT_CAPTCHA);
        if (captcha) {
          onLog(`🧩 提交时出现验证码（${captcha.kind} ${captcha.w}x${captcha.h}），窗口已置前：请手动完成`);
          try { win.show(); win.focus(); win.moveTop(); } catch { /* */ }
          for (let w = 0; w < 120; w += 1) {
            if (shouldStop()) throw new Error('用户取消');
            await sleep(1000);
            const r2 = await Promise.race([respPending, Promise.resolve(null)]);
            if (r2) { registerResp = r2; requestSeen = true; break; }
            if (!win.webContents.getURL().includes('/sign-up')) { redirected = true; break; }
            if (!(await evalOnPage(win, JS_DETECT_CAPTCHA))) break;
          }
          break;
        }
        const errText = await evalOnPage(win, JS_ERROR_TEXT);
        if (errText) {
          onLog(`⚠️ 页面报错：${errText.slice(0, 140)}`);
          if (/risk|invalid|wrong|already|error|fail|错误|失败|无效|风险/i.test(errText)) {
            throw new Error(`注册被拦截：${errText.slice(0, 160)}`);
          }
        }
        const riskHit = await evalOnPage(win, `(function () { var t = (document.body && document.body.innerText) || ''; return t.indexOf('mailbox domain') >= 0 ? t.replace(/\\s+/g, ' ').slice(0, 200) : ''; })()`);
        if (riskHit) throw new Error(`邮箱域名风控拦截：${riskHit}`);
      }
    }
    if (!requestSeen && !redirected && !registerResp) {
      onLog(`注册请求未发出，换定位策略重试 (${attempt + 1}/4)...`);
    }
  }

  // 拿到响应体了：解析成功/失败
  // 宽容策略（参照 TraeAccountCreatorPlus：成功标志=URL 跳转 + 接口 message:success）：
  // 只有明确错误结构（ResponseMetadata.Error.Code）或明确的 error/message 文本才算失败，
  // "success"/"ok"/"succeed" 等语义视为成功；最终成败仍由 waitForLoginLanded 的 GetUserToken 实证兜底
  if (registerResp) {
    const rawBody = String(registerResp.body || '');
    if (rawBody) onLog(`注册接口响应：HTTP ${registerResp.status} ${rawBody.slice(0, 400)}`);
    let apiErr = '';
    let bodyNote = '';
    try {
      const d = JSON.parse(rawBody);
      const metaErr = d?.ResponseMetadata?.Error;
      if (metaErr?.Code) {
        apiErr = `code=${metaErr.Code} ${(metaErr.Message || metaErr.Data?.['__Message.error'] || '').slice(0, 120)}`;
      } else if (d?.error || d?.message) {
        const msg = String(d.error || d.message);
        if (/^(success|ok|successful|succeed)$/i.test(msg.trim())) {
          bodyNote = `（${msg.trim()}）`;
        } else {
          apiErr = msg.slice(0, 160);
        }
      }
    } catch { /* 非 JSON 不处理 */ }
    if (apiErr) {
      onLog(`❌ 注册接口返回错误：HTTP ${registerResp.status} ${apiErr}`);
      // 验证码错误：清掉重填再试（仅限首次错误，避免死循环）
      if (/wrong|invalid|expire|code.*(incorrect|not match)|验证码.*(错误|无效|过期)/i.test(apiErr)) {
        onLog('验证码可能错误/过期，重新请求验证码...');
        // 这里不自动重发：抛错让外层决定，避免无限重试消耗临时邮箱额度
      }
      throw new Error(`注册失败：${apiErr}`);
    }
    onLog(`✅ 注册接口返回成功（HTTP ${registerResp.status}）${bodyNote}`);
    requestSeen = true;
  }

  if (!requestSeen && !redirected) {
    const dump = await evalOnPage(win, `(function () {
      const btns = [...document.querySelectorAll('button, [role="button"]')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 12);
      const inputs = [...document.querySelectorAll('input')].map((el) => el.type + ':' + (el.placeholder || '') + ':' + JSON.stringify(el.value).slice(0, 30)).slice(0, 8);
      return JSON.stringify({ url: location.href, btns, inputs, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) });
    })()`);
    onLog(`SUBMIT-DUMP ${dump || '页面无响应'}`);
    throw new Error('Sign Up 点击后注册请求未发出');
  }
  await handleCaptcha(win, onLog, shouldStop);

  // 成功判定以登录态 Cookie 为准：register_verify_login 成功时 Set-Cookie 由网络层落地，
  // 前端即使不跳转 Cookie 也在（实测官网就是不跳转）；URL 跳转仅作提前信号；
  // verify=true：游客 sessionid 会造成假阳性，命中后窗口内 GetUserToken 实证才算数
  if (!redirected) {
    const landed = await waitForLoginLanded(win, ses, {
      stopPath: '/sign-up',
      cookiePattern: edition.siteCookiePattern,
      attempts: 40,
      onLog,
      shouldStop,
      verify: true,
    });
    if (!landed) throw new Error('提交后未确认登录态（无跳转、登录 Cookie 无效或被风控拦截）');
  }
  onLog('✅ 注册成功（登录态 Cookie 已落地）');
  // 注册即登录：sessionid 等 Cookie 已落在 trae.ai 域，登录页/授权页同域共用。
  // 不走站点登录表单——trae.ai 把 maxxspace.com 标 "at risk" 专拦表单提交；
  // 礼包改为 Token 入库后 API 直调（registerOne 内），不再开礼包页
  return { email, password };
}

// CN：手机号+验证码登录（trae.cn 无独立注册页，手机号首次验证码登录即注册）
async function registerCnFlow(win, ses, fired, options, onLog, shouldStop, askUser) {
  const edition = getEdition('cn');
  const provider = createSmsProvider(options.smsSettings, askUser, onLog);

  const { orderId, phone } = await provider.requestNumber();
  onLog(`📱 取号成功：+86 ${phone}`);

  await win.loadURL(edition.loginUrl);
  onLog('已打开登录页，模拟人类浏览行为...');
  await simulateHumanBrowsing(win);

  const phonePatterns = ['输入手机号', '手机号', 'phone', 'mobile', 'tel'];
  const codePatterns = ['输入验证码', '验证码', 'verification', 'code'];
  const phoneInput = await waitForPageState(win, findInputScript(phonePatterns), { attempts: 20, intervalMs: 500, shouldStop });
  if (!phoneInput) throw new Error('找不到手机号输入框（页面改版？）');
  if (!(await typeHumanInto(win, phonePatterns, phone, shouldStop, onLog))) throw new Error('手机号填写失败');

  onLog('请求发送短信验证码...');
  let codeRequested = false;
  for (let attempt = 0; attempt < 3 && !codeRequested; attempt += 1) {
    if (shouldStop()) throw new Error('用户取消');
    if (!(await ensureFilled(win, phonePatterns, phone, shouldStop, onLog))) throw new Error('手机号字段找回失败');
    fired.phoneSendCode = false;
    const clicked = await clickButtonByText(win, '获取验证码|发送验证码|获取|发送|send', 0);
    if (!clicked) {
      if (attempt === 0) throw new Error('找不到「获取验证码」按钮');
      codeRequested = true;
      break;
    }
    for (let i = 0; i < 12; i += 1) {
      await sleep(500);
      if (fired.phoneSendCode) { codeRequested = true; break; }
    }
    if (!codeRequested) onLog(`发码请求未发出，重试点击 (${attempt + 1}/3)...`);
  }
  if (!codeRequested) throw new Error('获取验证码点击后请求未发出');
  onLog('发码请求已确认，等待风控判定（可能弹滑块）...');
  await handleCaptcha(win, onLog, shouldStop);

  const code = await pollForCode(provider, orderId, {
    attempts: options.smsSettings?.smsMode === 'http' ? 36 : 60,
    intervalMs: 5000,
    onLog: (m) => onLog(`📱 ${m}`),
  });
  onLog(`✉️ 收到验证码：${code}`);

  if (!(await typeHumanInto(win, codePatterns, code, shouldStop, onLog))) throw new Error('验证码填写失败');

  onLog('点击「登录」提交...');
  let requestSeen = false;
  for (let attempt = 0; attempt < 3 && !requestSeen; attempt += 1) {
    if (shouldStop()) throw new Error('用户取消');
    await ensureFilled(win, phonePatterns, phone, shouldStop, onLog);
    await ensureFilled(win, codePatterns, code, shouldStop, onLog);
    fired.phoneLogin = false;
    let clicked = false;
    if (attempt === 0) clicked = await clickFormSubmit(win);
    if (!clicked) clicked = await clickButtonByText(win, '^登录$|^log\\s*in$', 0);
    if (!clicked) {
      onLog('未定位到登录按钮，稍后重试...');
      await sleep(2000);
      continue;
    }
    for (let i = 0; i < 12; i += 1) {
      await sleep(500);
      if (fired.phoneLogin) { requestSeen = true; break; }
      if (!win.webContents.getURL().includes('/login')) break;
    }
    if (!requestSeen) onLog(`登录请求未确认，重试 (${attempt + 1}/3)...`);
  }

  await handleCaptcha(win, onLog, shouldStop);
  const landed = await waitForLoginLanded(win, ses, {
    stopPath: '/login',
    cookiePattern: edition.siteCookiePattern,
    attempts: 40,
    onLog,
    shouldStop,
  });
  if (!landed) throw new Error('提交后 20 秒未确认登录态（无跳转且无 session Cookie）');
  onLog('✅ 登录成功（手机号首次登录即完成注册）');
  return { phone };
}

// 新版授权页已登录态按钮为 "open TRAE and upgrade"（旧版为 "Log in and open TRAE"），
// 点击后 GetPCAuthCode 签发，但新版改走 trae:// 协议唤起本地 IDE、不再跳 127.0.0.1 HTTP 回调；
// 本机无协议处理程序会弹系统"选择应用"框并死锁，必须截获协议 URL 自行提取 AuthCode 换 Token
const AUTH_BUTTON_PATTERN = 'log\\s*in\\s*and\\s*open|open\\s*trae';

function extractAuthCodeFromProtocolUrl(url) {
  const m = String(url).match(/authCode(?:Info)?=([^&#]+)/);
  if (!m) return '';
  const raw = decodeURIComponent(m[1]);
  try {
    const info = JSON.parse(raw);
    if (info && (info.AuthCode || info.authCode)) return info.AuthCode || info.authCode;
  } catch { /* 非 JSON 视为裸 code */ }
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : '';
}

// IDE 同源 OAuth 授权：以当前窗口登录态打开 authorization 页（auth_from=trae），
// 授权组件渲染确认按钮，点击后 GetPCAuthCode 签发；回调走 HTTP（旧版）或 trae:// 协议（新版），
// 收 AuthCode 后 ExchangeToken 换 Token（JWT source=refresh_token，签到可用）
async function acquireTokenByIdeOAuth(win, edition, onLog, shouldStop) {
  const callback = new AuthCallbackServer(onLog);
  const pendingCb = callback.waitForCallback(120000);
  pendingCb.catch(() => null);
  // 截获 trae:// 协议跳转：will-navigate/did-start-navigation 双保险防漏，window.open 场景走 openHandler
  const caught = { protocolUrl: '' };
  const catchProtocol = (url) => {
    if (caught.protocolUrl) return;
    caught.protocolUrl = url;
    onLog(`📱 截获 trae:// 协议跳转：${url.slice(0, 400)}`);
  };
  const isTraeProtocol = (url) => /^trae:/i.test(url || '');
  const onWillNavigate = (e, url) => { if (isTraeProtocol(url)) { e.preventDefault(); catchProtocol(url); } };
  const onDidStart = (e, url) => { if (isTraeProtocol(url)) { e.preventDefault(); catchProtocol(url); } };
  const openHandler = ({ url }) => (isTraeProtocol(url) ? (catchProtocol(url), { action: 'deny' }) : { action: 'allow' });
  const wc = win.webContents;
  wc.on('will-navigate', onWillNavigate);
  wc.on('did-start-navigation', onDidStart);
  wc.setWindowOpenHandler(openHandler);
  try {
    const port = await callback.start();
    const { verifier, challenge } = makePkce();
    const { deviceId, machineId } = newDeviceIdentity();
    const devicePublicKey = generateDevicePublicKey();
    const url = buildAuthorizationUrl(edition, { port, deviceId, machineId, codeChallenge: challenge });
    onLog(`🔑 打开 IDE 授权页（IDE_PC 线，回调端口 ${port}）...`);
    await loadURLWithTimeout(win, url, 20000, onLog);

    await handleCaptcha(win, onLog, shouldStop);
    // 授权页不会自动回调：组件要求点击确认按钮，轮询点击直到回调/协议跳转落地或超时
    const deadline = Date.now() + 110000;
    let lastClickAt = 0;
    let lastPageText = '';
    while (Date.now() < deadline && !callback.received && !caught.protocolUrl) {
      if (shouldStop()) throw new Error('用户取消');
      const text = (await evalOnPage(win, JS_AUTH_PAGE_TEXT)) || '';
      lastPageText = text;
      if (/not available in your region|unavailable/i.test(text) && !/log in/i.test(text)) {
        throw new Error('授权页显示地区不可用（blockTTP 拦截）');
      }
      if (/login failed|登录失败/i.test(text)) throw new Error(`授权页失败：${text.slice(0, 120)}`);
      if (/at\s*risk|stable\s*mailbox/i.test(text)) {
        throw new Error('授权页域名风控拦截（mailbox domain at risk）');
      }
      if (Date.now() - lastClickAt > 3000) {
        const pos = await evalOnPage(win, buildScript(JS_LOCATE_BUTTON_STRICT, {
          '%PATTERN%': JSON.stringify(AUTH_BUTTON_PATTERN),
          '%PICK_INDEX%': '0',
        }));
        if (pos) {
          await clickAt(win, pos.x, pos.y);
          lastClickAt = Date.now();
          onLog('已点击授权确认按钮，等待 AuthCode 签发...');
        }
      }
      await sleep(2000);
    }

    if (caught.protocolUrl) {
      const code = extractAuthCodeFromProtocolUrl(caught.protocolUrl);
      if (!code) throw new Error(`trae:// 协议跳转无 AuthCode：${caught.protocolUrl.slice(0, 200)}`);
      onLog('从 trae:// 协议链接提取到 AuthCode，ExchangeToken 换取 Token...');
      return await exchangeTokenWithFallback(edition, {
        authCode: code,
        codeVerifier: verifier,
        deviceId,
        machineId,
        devicePublicKey,
      }, onLog, '');
    }

    const payload = callback.received;
    if (!payload || !payload.authCode) {
      if (lastPageText) onLog(`授权页文本快照：${lastPageText}`);
      throw new Error('授权回调超时（未收到 AuthCode）');
    }

    onLog('AuthCode 已获取，ExchangeToken 换取 Token...');
    return await exchangeTokenWithFallback(edition, {
      authCode: payload.authCode,
      codeVerifier: payload.codeVerifier || verifier,
      deviceId,
      machineId,
      devicePublicKey,
    }, onLog, payload.host);
  } finally {
    callback.close();
    try {
      wc.removeListener('will-navigate', onWillNavigate);
      wc.removeListener('did-start-navigation', onDidStart);
    } catch { /* webContents 可能已销毁 */ }
  }
}

async function registerOne(options, onLog, shouldStop, askUser) {
  const edition = getEdition(normalizeEdition(options.edition));
  let win = null;
  let ses = null;
  let identity = '';

  try {
    if (shouldStop()) throw new Error('用户取消');
    const ctx = await createRegisterWindow(options, edition, onLog, shouldStop);
    win = ctx.win;
    ses = ctx.ses;

    let flowResult;
    if (edition.id === 'intl') {
      flowResult = await registerIntlFlow(win, ses, ctx.fired, ctx.netMonitor, options, onLog, shouldStop);
      identity = flowResult.email;
    } else {
      flowResult = await registerCnFlow(win, ses, ctx.fired, options, onLog, shouldStop, askUser);
      identity = `+86${flowResult.phone}`;
    }

    // 凭证先落日志：后续取 Token 链路若全断，凭此可人工登录找回账号
    if (flowResult && flowResult.password) onLog(`🎫 注册凭证：${identity} / 密码 ${flowResult.password}`);

    // 取 Token 链路按可靠性排序（10:02 实测新版授权页 trae:// 跳转不带 AuthCode，
    // IDE 授权已非首选）；每环独立 try/catch，单环失败只记日志不再中断整链
    const cookieStr = await exportCookieString(ses);
    let brief = null;
    let userToken = '';
    let lastTokenError = '';

    // 首选：注册窗口同源直调——注册流程刚结束，窗口仍停在已登录站点页，
    // Cookie 最新鲜且免导出丢字段（09:58/10:02 两批失败的根因都是先跑授权把窗口导航走了）
    if (win && !win.isDestroyed()) {
      try {
        const inPage = await fetchUserTokenInPage(win, onLog);
        if (inPage) {
          onLog('🔑 注册窗口同源直调 User Token 成功');
          userToken = inPage.token;
          brief = await accountStore.addAccountByToken(userToken, { cookies: cookieStr, email: identity, edition: edition.id });
        }
      } catch (err) {
        if (/已存在/.test(err.message)) throw err;
        lastTokenError = err.message;
        onLog(`窗口内直调失败(${err.message})`);
      }
    }

    // 回退1：Cookie 直刷（多基地探测）
    if (!brief) {
      try {
        const direct = await getUserToken(cookieStr);
        onLog('🔑 Cookie 直刷 User Token 成功');
        userToken = direct.token;
        brief = await accountStore.addAccountByToken(userToken, { cookies: cookieStr, email: identity, edition: edition.id });
      } catch (err) {
        if (/已存在/.test(err.message)) throw err;
        lastTokenError = err.message;
        onLog(`Cookie 直刷失败(${err.message})`);
      }
    }

    // 回退2：IDE 授权（旧版 HTTP 回调链路；新版 trae:// 跳转无 AuthCode 大概率失败，仅兜底）
    if (!brief && win && !win.isDestroyed()) {
      try {
        const tokenResult = await acquireTokenByIdeOAuth(win, edition, onLog, shouldStop);
        userToken = tokenResult.token;
        brief = await accountStore.addAccountByToken(userToken, {
          cookies: cookieStr,
          email: identity,
          edition: edition.id,
          tokenExpiredAt: tokenResult.expiredAt || null,
        });
      } catch (err) {
        if (/已存在/.test(err.message)) throw err;
        lastTokenError = err.message;
        onLog(`IDE 授权链路失败(${err.message})`);
      }
    }

    // 回退3：同 session 新开隐藏窗口访问账号设置页，CDP 拦截站点自发的 GetUserToken
    if (!brief && edition.id === 'intl') {
      try {
        const siteTok = await captureSiteToken(ses, onLog);
        if (siteTok && siteTok.token) {
          userToken = siteTok.token;
          brief = await accountStore.addAccountByToken(userToken, { cookies: cookieStr, email: identity, edition: edition.id });
        }
      } catch (err) {
        if (/已存在/.test(err.message)) throw err;
        lastTokenError = err.message;
      }
    }

    if (!brief) throw new Error(lastTokenError || '未获取到可用 User Token');
    onLog(`🎉 [${identity}] 已加入账号列表`);

    // 周年礼包 API 直调（免开礼包页），失败不影响注册结果
    if (options.claimGift && edition.id === 'intl' && userToken) {
      try {
        const gift = await claimBirthdayBonus(userToken);
        onLog(gift.claimed ? '🎁 周年礼包已领取' : `🎁 礼包未领取（${gift.message}）`);
      } catch (err) {
        onLog(`⚠️ 礼包领取失败(${err.message})，不影响注册结果`);
      }
    }
    return { success: true, edition: edition.id, identity, password: flowResult.password || '', accountId: brief.id };
  } catch (err) {
    onLog(`❌ [${identity || edition.label}] ${err.message}`);
    if (process.env.TRAEHOP_TEST_REGISTER === '1' && win && !win.isDestroyed()) {
      try {
        const dump = await win.webContents.executeJavaScript(`(function () {
          const directText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
          const sendHits = [...document.querySelectorAll('button, [role="button"], span, div, a')].filter((el) => /send\\s*code|发送验证码|获取验证码/i.test(directText(el)));
          const sendHtml = sendHits.length ? (sendHits[0].outerHTML + ' ||| PARENT: ' + (sendHits[0].parentElement ? sendHits[0].parentElement.outerHTML.slice(0, 600) : '')) : 'NONE';
          return JSON.stringify({
            url: location.href,
            visibility: document.visibilityState,
            hasFocus: document.hasFocus(),
            activeElement: (document.activeElement && (document.activeElement.tagName + ':' + (document.activeElement.placeholder || document.activeElement.className || ''))) || '',
            sendHtml: sendHtml.slice(0, 1200),
            hasReact: !!(window.React || window.__NEXT_DATA__ || document.querySelector('#__next, [data-reactroot]')),
            scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((s) => /captcha|turnstile|cloudflare|recaptcha|hcaptcha/i.test(s)).slice(0, 10),
            iframes: [...document.querySelectorAll('iframe')].map((f) => f.src || f.title || '').slice(0, 10),
            text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500),
          });
        })()`, true);
        onLog(`DEBUG2 ${dump}`);
      } catch { /* */ }
      if (ses) {
        try {
          const ck = await ses.cookies.get({});
          onLog(`COOKIES ${ck.map((c) => `${c.name}@${(c.domain || '').slice(0, 24)}`).join(' | ')}`);
        } catch { /* */ }
      }
    }
    return { success: false, edition: edition.id, identity, message: err.message };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (ses) {
      ses.clearStorageData().catch(() => {});
    }
  }
}

let stopRequested = false;

function cancelRegister() {
  stopRequested = true;
}

async function runRegisterBatch({ total, concurrency, claimGift, proxies, pace, edition, smsSettings }, rawOnLog = () => {}, askUser = null) {
  stopRequested = false;
  const proxyList = (proxies || []).map((p) => p.trim()).filter(Boolean);
  const stats = { success: 0, fail: 0, total, pending: 0 };

  // 注册日志落盘：IPC 日志窗口关了就没，排查失败全靠这里。
  // 同步追加写：日志频率低不卡主进程，进程被强杀已写内容也不丢（WriteStream 缓冲曾实测丢失为 0 字节）
  let logFile = '';
  const onLog = (msg) => {
    rawOnLog(msg);
    if (!logFile) return;
    try { fs.appendFileSync(logFile, `[${new Date().toTimeString().slice(0, 8)}] ${msg}\n`); } catch { /* */ }
  };
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    logFile = path.join(logDir, `register-${stamp}.log`);
    onLog(`📄 注册日志落盘：${logFile}`);
  } catch { /* 落盘失败不影响注册 */ }

  let nextIndex = 0;
  async function worker(workerId) {
    let registeredBefore = false;
    while (!stopRequested && nextIndex < total) {
      const index = nextIndex;
      nextIndex += 1;

      // 节奏控制：只有上一个任务真的注册成功过才错峰等待，避免齐刷刷注册
      if (registeredBefore) {
        const gap = pace === 'fast' ? randomInt(8, 20) : randomInt(30, 90);
        onLog(`⏳ [worker ${workerId}] 错峰等待 ${gap}s...`);
        await sleep(gap * 1000);
      }
      if (stopRequested) return;

      stats.pending += 1;
      const proxy = proxyList.length ? proxyList[index % proxyList.length] : null;
      const result = await registerOne(
        { claimGift, proxy, edition, smsSettings },
        (msg) => onLog(`[worker ${workerId}] ${msg}`),
        () => stopRequested,
        askUser
      );
      stats.pending -= 1;
      if (result.success) {
        stats.success += 1;
        registeredBefore = true;
      } else {
        stats.fail += 1;
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency || 1, 3));
  const workers = [];
  for (let i = 0; i < n; i += 1) workers.push(worker(i + 1));
  await Promise.all(workers);

  onLog(stopRequested ? '>>> 注册任务已停止 <<<' : '>>> 注册任务完成 <<<');
  return { ...stats, cancelled: stopRequested };
}

module.exports = { runRegisterBatch, cancelRegister };
