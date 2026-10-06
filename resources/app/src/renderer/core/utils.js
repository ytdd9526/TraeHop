import { localeTag, t } from './i18n.js';

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function shortenPath(p) {
  const s = String(p);
  if (s.length <= 52) return s;
  const parts = s.split(/[/\\]/);
  if (parts.length > 3) return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
  return `…${s.slice(-48)}`;
}

export function formatResetCountdown(resetTimeSec) {
  if (!resetTimeSec) return '—';
  const diff = resetTimeSec * 1000 - Date.now();
  if (diff <= 0) return t('time.resetSoon');
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return t('time.daysHours', { days, hours });
  const mins = Math.floor((diff % 3600000) / 60000);
  return hours > 0 ? t('time.hoursMins', { hours, mins }) : t('time.minsOnly', { mins });
}

export function formatDateTime(resetTimeSec) {
  if (!resetTimeSec) return '—';
  return new Date(resetTimeSec * 1000).toLocaleString(localeTag(), {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatRefreshTime(date) {
  if (!date) return '—';
  return date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(localeTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function accountLabel(a) {
  return a?.email || a?.name || t('common.account');
}

export function appendDialogLog(sel, msg) {
  const el = $(sel);
  if (!el) return;
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

export async function asyncPool(items, concurrency, fn) {
  const results = [];
  const executing = [];
  for (let i = 0; i < items.length; i++) {
    const p = Promise.resolve().then(() => fn(items[i], i));
    results.push(p);
    if (items.length >= concurrency) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= concurrency) await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
}

export function rafDebounce(fn) {
  let ticking = false;
  return (...args) => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      fn(...args);
    });
  };
}

export function memoize(fn, keyFn = (...args) => JSON.stringify(args), ttlMs = 0) {
  const cache = new Map();
  return (...args) => {
    const key = keyFn(...args);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && (ttlMs <= 0 || now - cached.ts < ttlMs)) return cached.value;
    const value = fn(...args);
    if (value && typeof value.then === 'function') {
      return value.then((v) => {
        cache.set(key, { value: v, ts: Date.now() });
        return v;
      });
    }
    cache.set(key, { value, ts: now });
    return value;
  };
}

export function extractTokenPayload(input) {
  const trimmed = input.trim().replace(/[\r\n\t]/g, '');
  if (trimmed.startsWith('eyJ')) {
    const parts = trimmed.split('.');
    if (parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
      return { token: trimmed, tokenExpiredAt: null };
    }
  }
  try {
    const json = JSON.parse(trimmed);
    if (json.Result?.Token) {
      return { token: json.Result.Token, tokenExpiredAt: json.Result.ExpiredAt || null };
    }
    if (json.result?.token) {
      return {
        token: json.result.token,
        tokenExpiredAt: json.result.expiredAt || json.result.expired_at || null,
      };
    }
    if (json.token) return { token: json.token, tokenExpiredAt: json.expiredAt || null };
    if (json.Token) return { token: json.Token, tokenExpiredAt: json.ExpiredAt || null };
  } catch { /* */ }
  const m = trimmed.match(/"Token"\s*:\s*"(eyJ[^"]+)"/) || trimmed.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  const token = m ? (m[1] || m[0]) : null;
  if (!token) return null;
  const expiredMatch = trimmed.match(/"ExpiredAt"\s*:\s*"([^"]+)"/);
  return { token, tokenExpiredAt: expiredMatch?.[1] || null };
}
