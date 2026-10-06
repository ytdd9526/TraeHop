const accountStore = require('../account-store');
const traeProvider = require('./providers/trae');
const wbProvider = require('./providers/workbuddy');
const { getUsageSummary } = require('../trae-api');
const { asPerr, KIND_AUTH, KIND_QUOTA, KIND_RATE, KIND_SERVER, KIND_NETWORK, KIND_STREAM, KIND_MODEL, KIND_CLIENT } = require('./errors');

const providers = { trae: traeProvider, workbuddy: wbProvider };
const shortAlias = { wb: 'workbuddy', codebuddy: 'workbuddy', tr: 'trae' };

const COOLDOWN_MS = {
  [KIND_QUOTA]: 6 * 3600000,
  [KIND_RATE]: 5 * 60000,
  [KIND_SERVER]: 30000,
  [KIND_NETWORK]: 15000,
  [KIND_AUTH]: 3600000,
};

class Pool {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.rr = new Map();
    this.cooldowns = new Map();
  }

  provider(name) {
    return providers[name] || null;
  }

  providerNames() {
    return Object.keys(providers);
  }

  toSnapshot(a) {
    if (a.platform === 'trae') {
      const edition = accountStore.editionOfAccount(a);
      if (edition !== 'cn') return null;
      if (!a.token) return null;
      return {
        id: a.id,
        name: a.name || a.email || a.id.slice(0, 8),
        platform: 'trae',
        token: a.token,
        uid: a.userId || '',
        machineId: a.machineId || '',
        deviceId: traeProvider.deriveDeviceId(a.id),
        hasCookies: !!(a.cookies && a.cookies.trim()),
        expiresAt: a.tokenExp || null,
      };
    }
    if (a.platform === 'workbuddy') {
      if (!a.token || !a.wbEndpoint) return null;
      const endpoint = a.wbEndpoint.replace(/\/$/, '');
      const origin = endpoint.includes('workbuddy.ai') ? endpoint : 'https://www.codebuddy.cn';
      return {
        id: a.id,
        name: a.name || a.wbUid || a.id.slice(0, 8),
        platform: 'workbuddy',
        token: a.token,
        endpoint,
        origin,
        uid: a.wbUid || '',
        enterpriseId: a.wbEnterpriseId || '',
        domain: a.wbDomain || '',
      };
    }
    return null;
  }

  candidates(name) {
    const cfg = this.getConfig();
    if (!cfg.providers?.[name]?.enabled) return [];
    const raw = accountStore.listAccountsRaw();
    const now = Date.now();
    const out = [];
    for (const a of raw) {
      const snap = this.toSnapshot(a);
      if (!snap || snap.platform !== name) continue;
      const cd = this.cooldowns.get(snap.id);
      if (cd && cd.until > now) continue;
      out.push(snap);
    }
    return out;
  }

  unavailableReason(name) {
    const raw = accountStore.listAccountsRaw().filter((a) => a.platform === name);
    if (!raw.length) return `没有 ${name} 账号，请在账号页添加`;
    const now = Date.now();
    let cooling = 0;
    let invalid = 0;
    for (const a of raw) {
      const cd = this.cooldowns.get(a.id);
      if (cd && cd.until > now) {
        if (cd.dead) invalid++;
        else cooling++;
      }
    }
    const parts = [];
    if (cooling) parts.push(`冷却中 x${cooling}`);
    if (invalid) parts.push(`凭据失效 x${invalid}`);
    return parts.join('，') || '账号均不可用';
  }

  resolveModel(model) {
    const cfg = this.getConfig();
    if (model.includes(':')) {
      const segs = model.split(':');
      for (let i = 0; i < segs.length - 1; i++) {
        const name = segs[i].toLowerCase();
        if (providers[name]) return { name, bare: segs.slice(i + 1).join(':') };
        const real = shortAlias[name];
        if (real && providers[real]) return { name: real, bare: segs.slice(i + 1).join(':') };
      }
    }
    const routed = cfg.modelRoutes?.[model];
    if (routed && providers[routed]) return { name: routed, bare: model };
    let def = cfg.defaultProvider;
    if (!providers[def]) {
      def = this.providerNames().find((n) => cfg.providers?.[n]?.enabled) || def;
    }
    const bare = model.includes(':') ? model.split(':').pop() : model;
    return { name: def, bare };
  }

  async refreshAccount(snap) {
    if (snap.platform !== 'trae') return false;
    try {
      const token = await accountStore.ensureValidToken(snap.id);
      if (token) {
        snap.token = token;
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async traeQuotaProbe(snap) {
    try {
      const summary = await getUsageSummary(snap.token, 'cn');
      return summary?.displayLeft > 0;
    } catch {
      return null;
    }
  }

  async applyPolicy(snap, pe) {
    if (pe.kind === KIND_AUTH && !snap.hasCookies && snap.platform === 'trae') {
      this.cooldowns.set(snap.id, { until: Infinity, reason: `${pe.kind}: ${pe.message}`, dead: true });
      return;
    }
    if (pe.kind === KIND_QUOTA) {
      let ms = 6 * 3600000;
      if (snap.platform === 'trae') {
        const alive = await this.traeQuotaProbe(snap);
        if (alive === true) ms = 5 * 60000;
      }
      this.cooldowns.set(snap.id, { until: Date.now() + ms, reason: `quota: ${pe.message}` });
      return;
    }
    const d = COOLDOWN_MS[pe.kind];
    if (!d) return;
    this.cooldowns.set(snap.id, { until: Date.now() + d, reason: `${pe.kind}: ${pe.message}` });
  }

  clearCooldown(id) {
    this.cooldowns.delete(id);
  }

  async chat(model, openaiReq, sink) {
    const cfg = this.getConfig();
    const { name, bare } = this.resolveModel(model);
    const prov = providers[name];
    if (!prov) throw asPerr(new Error('没有可用的提供商（检查网关设置）'));
    let req = openaiReq;
    if (bare && bare !== model) {
      try {
        const m = JSON.parse(openaiReq);
        if (m && m.model !== undefined) {
          m.model = bare;
          req = JSON.stringify(m);
        }
      } catch {
        /* 原样透传 */
      }
    }
    const ts = new TrackingSink(sink);
    const cands = this.candidates(name);
    if (!cands.length) {
      throw asPerr(new Error(`没有可用的 ${name} 账号：${this.unavailableReason(name)}`));
    }
    const defaultModel = cfg.providers?.[name]?.defaultModel || '';
    const connectTimeout = (cfg.connectTimeoutSec || 15) * 1000;
    let maxTries = cfg.maxRotate || 6;
    if (maxTries > cands.length * 2) maxTries = cands.length * 2;
    const tried = new Set();
    const refreshed = new Set();
    let lastErr = null;
    let attempts = 0;
    while (attempts < maxTries) {
      const idx = (this.rr.get(name) || 0) % cands.length;
      this.rr.set(name, ((this.rr.get(name) || 0) + 1) % cands.length);
      const snap = cands[idx];
      if (tried.has(snap.id)) {
        if (tried.size >= cands.length) break;
        continue;
      }
      tried.add(snap.id);
      attempts++;
      const tokenExpired = snap.expiresAt ? snap.expiresAt * 1000 < Date.now() + 60000 : false;
      if (tokenExpired && !refreshed.has(snap.id)) {
        refreshed.add(snap.id);
        if (!(await this.refreshAccount(snap))) {
          await this.applyPolicy(snap, asPerr(new Error('token 刷新失败，请重新登录')));
          lastErr = asPerr(new Error('账号 token 刷新失败，请重新登录'));
          continue;
        }
      }
      let err;
      try {
        await prov.chat(snap, req, defaultModel, ts, connectTimeout);
        this.clearCooldown(snap.id);
        return;
      } catch (e) {
        err = asPerr(e);
      }
      lastErr = err;
      if (ts.written) {
        await this.applyPolicy(snap, err);
        throw err;
      }
      if (err.kind === KIND_CLIENT || err.kind === KIND_MODEL) throw err;
      if (err.kind === KIND_AUTH && !refreshed.has(snap.id)) {
        refreshed.add(snap.id);
        if (await this.refreshAccount(snap)) {
          try {
            await prov.chat(snap, req, defaultModel, ts, connectTimeout);
            this.clearCooldown(snap.id);
            return;
          } catch (e2) {
            err = asPerr(e2);
            lastErr = err;
            if (ts.written) {
              await this.applyPolicy(snap, err);
              throw err;
            }
          }
        }
      }
      await this.applyPolicy(snap, err);
      if (err.kind === KIND_STREAM) throw err;
    }
    throw lastErr || asPerr(new Error('全部账号尝试失败'));
  }

  async allModels() {
    const cfg = this.getConfig();
    const out = {};
    for (const [name, prov] of Object.entries(providers)) {
      if (!cfg.providers?.[name]?.enabled) continue;
      const cands = this.candidates(name);
      let list = null;
      for (const snap of cands) {
        try {
          const l = await prov.models(snap, (cfg.connectTimeoutSec || 15) * 1000);
          if (l?.length) {
            list = l;
            break;
          }
        } catch {
          /* 试下一个账号 */
        }
      }
      out[name] = list || prov.seedModels;
    }
    return out;
  }

  status() {
    const now = Date.now();
    return accountStore.listAccountsRaw().map((a) => {
      const cd = this.cooldowns.get(a.id);
      const active = cd && cd.until > now;
      return {
        id: a.id,
        platform: a.platform,
        name: a.name || a.email || '',
        cooldownUntil: active && cd.until !== Infinity ? cd.until : 0,
        dead: !!(active && cd.dead),
        reason: active ? cd.reason : '',
      };
    });
  }
}

class TrackingSink {
  constructor(inner) {
    this.inner = inner;
    this.written = false;
  }
  delta(d) {
    if (d.content || d.reasoning || d.tool) this.written = true;
    this.inner.delta(d);
  }
  finish(f) {
    this.inner.finish(f);
  }
  streamError(code, msg) {
    this.inner.streamError(code, msg);
  }
  close() {
    this.inner.close();
  }
}

module.exports = { Pool };
