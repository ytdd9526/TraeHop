const accountStore = require('../account-store');
const { runCheckinAll } = require('../checkin');
const traeApi = require('../trae-api');
const { getUsageSummary } = traeApi;

class Scheduler {
  constructor({ getConfig, pool, isCheckinRunning, setCheckinRunning, onLog }) {
    this.getConfig = getConfig;
    this.pool = pool;
    this.isCheckinRunning = isCheckinRunning || (() => false);
    this.setCheckinRunning = setCheckinRunning || (() => {});
    this.onLog = onLog || (() => {});
    this.timers = [];
    this.lastCheckinSlot = '';
    this.quotaBusy = false;
  }

  start() {
    this.stop();
    const cfg = this.getConfig();
    this.timers.push(setInterval(() => this.runCheckinPass(), 60000));
    this.timers.push(setInterval(() => this.runTokenRefresh(), 3600000));
    if (cfg.quotaRefreshSec > 0) {
      this.timers.push(setInterval(() => this.runQuotaRefresh(), Math.max(60, cfg.quotaRefreshSec) * 1000));
    }
    setTimeout(() => this.runCheckinPass(), 8000);
    setTimeout(() => this.runTokenRefresh(), 30000);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async runCheckinPass() {
    const cfg = this.getConfig();
    if (!cfg.autoCheckin) return;
    const now = new Date();
    const slot = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}`;
    if (this.lastCheckinSlot === slot) return;
    const hours = Array.isArray(cfg.checkinHours) ? cfg.checkinHours : [9, 21];
    if (!hours.includes(now.getHours())) return;
    if (this.isCheckinRunning()) return;
    this.setCheckinRunning(true);
    try {
      this.lastCheckinSlot = slot;
      await runCheckinAll((msg) => this.onLog(`[网关调度] ${msg}`));
    } catch (err) {
      this.onLog(`[网关调度] 签到失败: ${err.message}`);
    } finally {
      this.setCheckinRunning(false);
    }
  }

  async runTokenRefresh() {
    try {
      const result = await accountStore.refreshAllExpiredTokens();
      const n = (result?.refreshed || 0) + (result?.synced || 0);
      if (n > 0) this.onLog(`[网关调度] 已刷新 ${n} 个临期 Token`);
    } catch {
      /* 忽略本轮刷新失败 */
    }
  }

  async runQuotaRefresh() {
    const cfg = this.getConfig();
    if (!cfg.traeAutoSwitch || this.quotaBusy) return;
    this.quotaBusy = true;
    try {
      await accountStore.refreshAllProfiles();
      if (cfg.traeAutoSwitch) await this.autoSwitchIfExhausted();
    } catch {
      /* 忽略本轮额度刷新失败 */
    } finally {
      this.quotaBusy = false;
    }
  }

  async autoSwitchIfExhausted() {
    const accounts = accountStore.listAccountsRaw().filter((a) => a.platform === 'trae');
    for (const a of accounts) {
      if (!a.token) continue;
      let summary = null;
      try {
        summary = await getUsageSummary(a.token, 'cn');
      } catch {
        continue;
      }
      if (!summary || !summary.displayLimit || summary.displayLimit <= 0 || summary.displayLeft > 0) continue;
      const cd = this.pool.cooldowns.get(a.id);
      if (cd && cd.until > Date.now()) continue;
      this.pool.cooldowns.set(a.id, {
        until: Date.now() + 6 * 3600000,
        reason: `积分耗尽（余 ${summary.displayLeft}/${summary.displayLimit}），自动冷却；检测到积分恢复后自动回归`,
      });
    }
  }
}

module.exports = { Scheduler };
