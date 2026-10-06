const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStableDataDir } = require('../data-path');

const FILE = path.join(getStableDataDir(), 'gateway', 'shares.json');
const PROV_NAMES = ['trae', 'workbuddy'];

let shares = null;

function load() {
  if (shares) return shares;
  try {
    shares = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(shares)) shares = [];
  } catch {
    shares = [];
  }
  return shares;
}

function save() {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(shares, null, 2));
  fs.renameSync(tmp, FILE);
}

function defaultProv(enabled) {
  return { enabled: !!enabled, limit: 0, models: [], usedTokens: 0, usedReqs: 0 };
}

function mapProviders(prov) {
  const out = {};
  for (const name of PROV_NAMES) {
    const p = prov?.[name];
    out[name] = {
      enabled: p?.enabled === true,
      limit: Number(p?.limit) || 0,
      models: Array.isArray(p?.models) ? p.models : [],
      usedTokens: Number(p?.usedTokens) || 0,
      usedReqs: Number(p?.usedReqs) || 0,
    };
  }
  return out;
}

function all() {
  return load().map((s) => ({ ...s, providers: mapProviders(s.providers) }));
}

function create(name, provs) {
  const list = load();
  const s = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || '分享钥匙').slice(0, 40),
    key: 'sk-share-' + crypto.randomBytes(16).toString('hex'),
    enabled: true,
    providers: mapProviders(provs),
    lastUsedAt: 0,
    createdAt: Math.floor(Date.now() / 1000),
  };
  list.push(s);
  save();
  return { ...s, providers: mapProviders(s.providers) };
}

function update(id, fn) {
  const list = load();
  const target = list.find((e) => e.id === id);
  if (!target) throw new Error('分享钥匙不存在');
  fn(target);
  if (!target.providers || typeof target.providers !== 'object') target.providers = {};
  target.providers = mapProviders(target.providers);
  save();
  return { ...target, providers: mapProviders(target.providers) };
}

function remove(id) {
  const list = load();
  const i = list.findIndex((e) => e.id === id);
  if (i === -1) throw new Error('分享钥匙不存在');
  list.splice(i, 1);
  save();
}

function resolve(key) {
  if (!key) return null;
  const s = load().find((e) => e.key === key);
  if (!s) return null;
  return { ...s, providers: mapProviders(s.providers) };
}

function authorize(shareID, prov, model) {
  const list = load();
  const target = list.find((e) => e.id === shareID);
  if (!target) return '分享钥匙不存在或已被删除';
  if (!target.enabled) return '该分享钥匙已被停用';
  let ps = target.providers?.[prov];
  if (!ps) {
    ps = defaultProv(false);
    target.providers = target.providers || {};
    target.providers[prov] = ps;
  }
  if (!ps.enabled) return `该分享钥匙未开放 ${prov}`;
  if (Array.isArray(ps.models) && ps.models.length && !containsModel(ps.models, model)) {
    return `该分享钥匙在 ${prov} 下仅允许使用模型：${ps.models.join('、')}`;
  }
  if (ps.limit > 0 && ps.usedTokens >= ps.limit) return `该分享钥匙在 ${prov} 的用量已达上限`;
  ps.usedReqs = (ps.usedReqs || 0) + 1;
  target.lastUsedAt = Math.floor(Date.now() / 1000);
  save();
  return '';
}

function containsModel(whitelist, model) {
  const m = String(model || '').toLowerCase().trim();
  return whitelist.some((w) => String(w).toLowerCase().trim() === m);
}

function record(shareID, prov, tokens) {
  if (!shareID || !(tokens > 0)) return;
  const list = load();
  const e = list.find((x) => x.id === shareID);
  if (!e) return;
  let ps = e.providers?.[prov];
  if (!ps) {
    ps = defaultProv(true);
    e.providers = e.providers || {};
    e.providers[prov] = ps;
  }
  ps.usedTokens = (ps.usedTokens || 0) + tokens;
  save();
}

module.exports = { all, create, update, remove, resolve, authorize, record };
