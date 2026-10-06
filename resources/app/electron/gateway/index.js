const config = require('./config');
const { Pool } = require('./pool');
const { Server, localIP } = require('./server');
const { Tunnel } = require('./tunnel');
const { Scheduler } = require('./scheduler');
const shares = require('./shares');
const usagelog = require('./usagelog');

class GatewayManager {
  constructor() {
    this.pool = new Pool(() => this.config);
    this.server = new Server({ getConfig: () => this.config, pool: this.pool });
    this.tunnel = new Tunnel();
    this.scheduler = null;
    this.running = false;
    this.config = config.get();
    this.onLog = () => {};
    this.schedulerCtx = null;
  }

  setLogSink(fn) {
    this.onLog = fn || (() => {});
  }

  setSchedulerContext(ctx) {
    this.schedulerCtx = ctx;
  }

  async start() {
    if (this.running) return this.status();
    this.config = config.get();
    const info = await this.server.listen();
    this.running = true;
    this.scheduler = new Scheduler({
      getConfig: () => this.config,
      pool: this.pool,
      isCheckinRunning: this.schedulerCtx?.isCheckinRunning || (() => false),
      setCheckinRunning: this.schedulerCtx?.setCheckinRunning || (() => {}),
      onLog: (msg) => this.onLog(msg),
    });
    this.scheduler.start();
    if (this.config.tunnel?.enabled) {
      this.tunnel.start(info.port, this.config.tunnel.host);
    }
    this.onLog(`网关已启动 http://${info.host}:${info.port}`);
    return this.status();
  }

  async stop() {
    this.tunnel.stop();
    this.scheduler?.stop();
    await this.server.close();
    this.running = false;
    this.onLog('网关已停止');
    return this.status();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async applyConfig(partial) {
    const prev = this.config;
    this.config = config.save(partial);
    if (!this.running) return { config: { ...this.config }, restarted: false };
    const needRestart =
      prev.port !== this.config.port ||
      prev.host !== this.config.host ||
      JSON.stringify(prev.providers) !== JSON.stringify(this.config.providers) ||
      prev.defaultProvider !== this.config.defaultProvider ||
      prev.maxRotate !== this.config.maxRotate ||
      prev.connectTimeoutSec !== this.config.connectTimeoutSec;
    if (needRestart) {
      await this.restart();
      return { config: { ...this.config }, restarted: true };
    }
    if (prev.tunnel?.enabled !== this.config.tunnel?.enabled || prev.tunnel?.host !== this.config.tunnel?.host) {
      if (this.config.tunnel?.enabled) this.tunnel.start(this.server.port, this.config.tunnel.host);
      else this.tunnel.stop();
    }
    return { config: { ...this.config }, restarted: false };
  }

  resetApiKey() {
    return config.resetApiKey();
  }

  async status() {
    const cfg = this.config;
    const lan = this.running ? await localIP() : '127.0.0.1';
    return {
      running: this.running,
      host: cfg.host,
      port: this.running ? this.server.port : cfg.port,
      baseUrl: this.running ? `http://${cfg.host === '0.0.0.0' ? lan : cfg.host}:${this.server.port || cfg.port}` : '',
      lanUrl: this.running ? `http://${lan}:${this.server.port}` : '',
      tunnel: this.tunnel.status(),
      providers: Object.fromEntries(
        this.pool.providerNames().map((name) => [
          name,
          { enabled: cfg.providers?.[name]?.enabled !== false, accounts: this.pool.candidates(name).length },
        ])
      ),
    };
  }

  async modelsDetail() {
    const cfg = this.config;
    const all = await this.pool.allModels();
    const out = [];
    for (const name of this.pool.providerNames()) {
      out.push({
        provider: name,
        enabled: cfg.providers?.[name]?.enabled !== false,
        available: this.pool.candidates(name).length,
        models: (all[name] || []).map((m) => ({ ...m })),
      });
    }
    return out;
  }

  usageLog(limit) {
    return usagelog.list(limit);
  }

  sharesAll() {
    return shares.all();
  }

  shareCreate(name, provs) {
    return shares.create(name, provs);
  }

  shareUpdate(id, fn) {
    return shares.update(id, fn);
  }

  shareRemove(id) {
    shares.remove(id);
  }
}

const manager = new GatewayManager();

module.exports = { gateway: manager, GatewayManager };
