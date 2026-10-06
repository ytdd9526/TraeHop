import { state } from '../core/state.js';
import { t } from '../core/i18n.js';

export function getUsageMetrics(usage) {
  const isDollar = !!usage?.isDollarBilling;
  const used = usage?.displayUsed ?? 0;
  const limit = usage?.displayLimit ?? 0;
  const left = usage?.displayLeft ?? Math.max(0, limit - used);
  const exhausted = !!usage?.exhausted;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return {
    isDollar, used, limit, left, exhausted, pct,
    usedText: isDollar ? `$${Number(used).toFixed(2)}` : String(Math.round(used)),
    limitText: isDollar ? `$${Number(limit).toFixed(2)}` : String(Math.round(limit)),
    leftText: exhausted ? t('overview.exhausted') : isDollar ? `$${left.toFixed(2)}` : String(Math.round(left)),
    leftNum: left,
  };
}

export function getAccountQuotaStatus(account) {
  if (account.platform === 'workbuddy') return 'unknown';
  if (account.tokenExpired) return 'no-quota';
  const u = state.usageMap[account.id];
  if (u?.loading) return 'unknown';
  if (u?.error) return 'no-quota';
  if (!u?.data) return 'unknown';
  const m = getUsageMetrics(u.data);
  if (m.exhausted || m.left <= 0) return 'no-quota';
  return 'has-quota';
}

export function computeStats(accounts) {
  let hasQuota = 0, noQuota = 0, expired = 0, expiring = 0;
  let totalUsed = 0, totalLimit = 0, totalLeft = 0, nearestReset = 0, anyDollar = false;

  for (const a of accounts) {
    if (a.tokenExpired) { expired += 1; noQuota += 1; continue; }
    if (a.tokenExpiringSoon) expiring += 1;
    const status = getAccountQuotaStatus(a);
    if (status === 'has-quota') hasQuota += 1;
    else if (status === 'no-quota') noQuota += 1;
    const u = state.usageMap[a.id]?.data;
    if (u) {
      if (u.isDollarBilling) anyDollar = true;
      const m = getUsageMetrics(u);
      totalUsed += m.used; totalLimit += m.limit; totalLeft += m.left;
      if (u.resetTime && (!nearestReset || u.resetTime < nearestReset)) nearestReset = u.resetTime;
    }
  }

  const usedPct = totalLimit > 0 ? Math.min(100, Math.round((totalUsed / totalLimit) * 100)) : 0;
  const fmt = (v) => (anyDollar ? `$${v.toFixed(2)}` : String(Math.round(v)));
  return { total: accounts.length, hasQuota, noQuota, expired, expiring, totalUsed, totalLimit, totalLeft, usedPct, nearestReset, anyDollar, fmt };
}
