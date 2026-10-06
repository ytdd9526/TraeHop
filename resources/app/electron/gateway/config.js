const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStableDataDir } = require('../data-path');

const FILE = path.join(getStableDataDir(), 'gateway', 'config.json');

const DEFAULTS = {
  autoStart: true,
  host: '127.0.0.1',
  port: 8690,
  apiKey: '',
  defaultProvider: 'trae',
  modelRoutes: {},
  providers: {
    trae: { enabled: true, defaultModel: '' },
    workbuddy: { enabled: true, defaultModel: '' },
  },
  exposePrefixModels: true,
  maxRotate: 6,
  connectTimeoutSec: 15,
  upstreamTimeoutSec: 600,
  autoCheckin: true,
  checkinHours: [9, 21],
  quotaRefreshSec: 300,
  refreshSkewMin: 1440,
  traeAutoSwitch: true,
  tunnel: { enabled: false, host: 'bore.pub' },
};

let cache = null;

function genKey() {
  return 'sk-' + crypto.randomBytes(18).toString('hex');
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function sanitize(cfg) {
  const c = deepMerge(DEFAULTS, cfg);
  c.port = Math.min(65535, Math.max(1, Number(c.port) || DEFAULTS.port));
  c.maxRotate = Math.min(32, Math.max(1, Number(c.maxRotate) || DEFAULTS.maxRotate));
  c.connectTimeoutSec = Math.min(120, Math.max(3, Number(c.connectTimeoutSec) || DEFAULTS.connectTimeoutSec));
  c.upstreamTimeoutSec = Math.min(3600, Math.max(30, Number(c.upstreamTimeoutSec) || DEFAULTS.upstreamTimeoutSec));
  if (!['trae', 'workbuddy'].includes(c.defaultProvider)) c.defaultProvider = 'trae';
  c.checkinHours = Array.isArray(c.checkinHours) ? c.checkinHours.map((h) => Number(h) || 0).filter((h) => h >= 0 && h <= 23) : DEFAULTS.checkinHours;
  if (!c.apiKey || typeof c.apiKey !== 'string' || !c.apiKey.startsWith('sk-')) c.apiKey = genKey();
  if (!c.providers || typeof c.providers !== 'object') c.providers = {};
  for (const name of ['trae', 'workbuddy']) {
    if (!c.providers[name] || typeof c.providers[name] !== 'object') {
      c.providers[name] = { ...DEFAULTS.providers[name] };
    } else {
      c.providers[name] = {
        enabled: c.providers[name].enabled !== false,
        defaultModel: String(c.providers[name].defaultModel || ''),
      };
    }
  }
  if (!c.tunnel || typeof c.tunnel !== 'object') c.tunnel = { ...DEFAULTS.tunnel };
  c.tunnel = { enabled: !!c.tunnel.enabled, host: String(c.tunnel.host || DEFAULTS.tunnel.host) };
  return c;
}

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    raw = null;
  }
  cache = sanitize(raw);
  persist(cache);
  return cache;
}

function persist(cfg) {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, FILE);
}

function get() {
  return { ...load() };
}

function save(partial) {
  const next = sanitize(deepMerge(load(), partial));
  cache = next;
  persist(next);
  return { ...next };
}

function resetApiKey() {
  const key = genKey();
  save({ apiKey: key });
  return key;
}

module.exports = { get, save, resetApiKey, DEFAULTS };
