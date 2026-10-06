const KIND_QUOTA = 'quota';
const KIND_RATE = 'rate';
const KIND_AUTH = 'auth';
const KIND_MODEL = 'model';
const KIND_CLIENT = 'client';
const KIND_SERVER = 'server';
const KIND_NETWORK = 'network';
const KIND_STREAM = 'stream';

class ProviderError extends Error {
  constructor(kind, status, msg) {
    super(msg);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status || 0;
  }
}

function perr(kind, status, msg) {
  return new ProviderError(kind, status, msg);
}

const quotaRe = /insufficient|quota|balance|credit|exceed|no available|额度|余额|积分不足|已用完|超出|资源包/i;
const authRe = /invalid_grant|invalid_token|expired_token|unauthorized|令牌已过期|验证不正确/i;
const modelRe = /model.*(not found|not exist|不支持|不存在)|not a valid model|unknown model/i;

function cut(s, n) {
  const r = [...String(s)];
  return r.length > n ? r.slice(0, n).join('') + '…' : String(s);
}

function classifyBody(status, body) {
  const text = typeof body === 'string' ? body : String(body || '');
  const trimmed = text.trim() || '(empty body)';
  if (status === 401 || status === 403) return perr(KIND_AUTH, status, cut(trimmed, 300));
  if (status === 429) return perr(KIND_RATE, status, cut(trimmed, 300));
  if (status === 402) return perr(KIND_QUOTA, status, cut(trimmed, 300));
  if (status >= 500) return perr(KIND_SERVER, status, cut(trimmed, 300));
  if (authRe.test(text)) return perr(KIND_AUTH, status, cut(trimmed, 300));
  if (quotaRe.test(text)) return perr(KIND_QUOTA, status, cut(trimmed, 300));
  if (modelRe.test(text)) return perr(KIND_MODEL, status, cut(trimmed, 300));
  if (status >= 400) return perr(KIND_CLIENT, status, cut(trimmed, 300));
  return perr(KIND_SERVER, status, cut(trimmed, 300));
}

function asPerr(err) {
  if (err instanceof ProviderError) return err;
  return perr(KIND_NETWORK, 0, err.message || String(err));
}

module.exports = {
  KIND_QUOTA,
  KIND_RATE,
  KIND_AUTH,
  KIND_MODEL,
  KIND_CLIENT,
  KIND_SERVER,
  KIND_NETWORK,
  KIND_STREAM,
  ProviderError,
  perr,
  classifyBody,
  asPerr,
};
