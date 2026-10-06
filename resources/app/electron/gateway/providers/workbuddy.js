const crypto = require('crypto');
const { doJSON, doStream, readBody } = require('../httpx');
const { scanSSE } = require('../sse');
const { perr, classifyBody, KIND_NETWORK } = require('../errors');

const UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

const seedModels = [
  'auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
  'claude-sonnet-4.6', 'claude-opus-4.6',
  'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex',
  'gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-image',
  'glm-5.3', 'glm-5.2', 'glm-5.3-flash',
  'kimi-k3', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5',
  'minimax-m3', 'hy3',
].map((id) => ({ id }));

function randHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function commonHeaders(acct) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: acct.origin,
    Referer: `${acct.origin}/`,
    'User-Agent': UA,
  };
}

function identityHeaders(h, acct) {
  if (acct.token) h.Authorization = `Bearer ${acct.token}`;
  else h['X-No-Authorization'] = '1';
  if (acct.uid) h['X-User-Id'] = String(acct.uid);
  else h['X-No-User-Id'] = '1';
  if (acct.enterpriseId) h['X-Enterprise-Id'] = String(acct.enterpriseId);
  else h['X-No-Enterprise-Id'] = '1';
  if (acct.domain) h['X-Domain'] = String(acct.domain);
  else h['X-No-Department-Info'] = '1';
  return h;
}

function chatHeaders(acct) {
  const h = commonHeaders(acct);
  h.Accept = 'application/json, text/event-stream';
  h['X-Product'] = 'SaaS';
  h['X-Request-ID'] = randHex(16);
  h['X-Request-Trace-Id'] = crypto.randomUUID();
  return identityHeaders(h, acct);
}

function prepareBody(openaiReq, defaultModel) {
  let src;
  try {
    src = JSON.parse(openaiReq);
  } catch (err) {
    throw perr('client', 400, `请求不是合法 JSON: ${err.message}`);
  }
  const b = src && typeof src === 'object' ? src : {};
  b.stream = true;
  if (!String(b.model || '').trim()) b.model = defaultModel;
  if (b.max_completion_tokens !== undefined) {
    if (b.max_tokens === undefined) b.max_tokens = b.max_completion_tokens;
    delete b.max_completion_tokens;
  }
  if (b.max_tokens === undefined) b.max_tokens = 16384;
  if (b.tool_choice !== undefined) {
    const r = normalizeToolChoice(b.tool_choice);
    if (r.drop) {
      delete b.tool_choice;
      delete b.tools;
      delete b.functions;
    } else if (r.value !== undefined) {
      b.tool_choice = r.value;
    } else {
      delete b.tool_choice;
    }
  }
  if (Array.isArray(b.messages) && b.messages.length) {
    for (const m of b.messages) {
      if (m && typeof m === 'object' && m.role === 'developer') m.role = 'system';
    }
    const first = b.messages[0];
    if (!first || first.role !== 'system') {
      b.messages = [{ role: 'system', content: 'You are a helpful AI assistant.' }, ...b.messages];
    }
  }
  return b;
}

function normalizeToolChoice(tc) {
  if (typeof tc === 'string') {
    if (tc === 'none') return { drop: true };
    return { value: tc };
  }
  if (tc && typeof tc === 'object') {
    const typ = tc.type;
    if (typ === 'none') return { drop: true };
    if (typ === 'any') return { value: 'required' };
    if (typ === 'auto' || typ === 'required') return { value: typ };
    if (typ === 'function') {
      if (tc.function?.name) return { value: tc.function.name };
      return { value: 'auto' };
    }
    return { value: 'auto' };
  }
  return { value: 'auto' };
}

async function chat(acct, openaiReq, defaultModel, sink, connectTimeoutMs) {
  const body = prepareBody(openaiReq, defaultModel);
  let res;
  try {
    res = await doStream('POST', `${acct.endpoint}/v2/chat/completions`, chatHeaders(acct), body, connectTimeoutMs);
  } catch (err) {
    sink.close();
    throw perr(KIND_NETWORK, 0, err.message);
  }
  if (res.statusCode >= 400) {
    const text = await readBody(res);
    sink.close();
    throw classifyBody(res.statusCode, text);
  }
  const ct = res.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    const text = await readBody(res);
    sink.close();
    throw classifyBody(res.statusCode, text);
  }
  return parseChatSSE(res, sink);
}

async function parseChatSSE(res, sink) {
  let firstRoleSent = false;
  let finish = '';
  let usage = null;
  let hasDelta = false;
  try {
    await scanSSE(res, (ev) => {
      const data = ev.data.trim();
      if (!data) return true;
      if (data === '[DONE]') return false;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return true;
      }
      if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) {
        if (chunk.error !== undefined || chunk.code !== undefined) {
          sink.streamError(extractCode(chunk.code, chunk.error), extractMsg(chunk));
          return false;
        }
        return true;
      }
      const c = chunk.choices[0];
      const d = c.delta || {};
      let delta = {};
      if (d.role && !firstRoleSent) {
        delta.role = d.role;
        firstRoleSent = true;
      }
      if (typeof d.content === 'string' && d.content) delta.content = d.content;
      if (d.reasoning_content) delta.reasoning = d.reasoning_content;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        for (const tc of d.tool_calls) {
          delta.tool = {
            index: tc.index || 0,
            id: tc.id || '',
            name: tc.function?.name || '',
            args: tc.function?.arguments || '',
          };
          hasDelta = true;
          sink.delta(delta);
          delta = {};
        }
      }
      if (delta.content || delta.reasoning || delta.role) {
        hasDelta = true;
        sink.delta(delta);
      }
      if (typeof c.finish_reason === 'string' && c.finish_reason) finish = c.finish_reason;
      if (chunk.usage) {
        usage = {
          present: true,
          prompt_tokens: chunk.usage.prompt_tokens || 0,
          completion_tokens: chunk.usage.completion_tokens || 0,
          total_tokens: chunk.usage.total_tokens || 0,
        };
      }
      return true;
    });
  } finally {
    res.destroy();
  }
  let reason = finish;
  if (!reason) {
    if (!hasDelta) sink.streamError(0, '上游返回空流');
    reason = 'stop';
  }
  sink.finish({ reason, usage });
}

function extractCode(code, errObj) {
  if (typeof code === 'number') return code;
  if (typeof code === 'string') return parseInt(code, 10) || 0;
  if (errObj && typeof errObj === 'object' && typeof errObj.code === 'number') return errObj.code;
  return 0;
}

function extractMsg(chunk) {
  if (typeof chunk.error === 'string') return chunk.error;
  if (chunk.error && typeof chunk.error === 'object' && chunk.error.message) return chunk.error.message;
  if (chunk.message) return chunk.message;
  return 'upstream error';
}

const mcache = new Map();

async function models(acct, connectTimeoutMs) {
  const cached = mcache.get(acct.endpoint);
  if (cached && Date.now() - cached.at < 300000) return cached.list;
  const h = chatHeaders(acct);
  h.Accept = 'application/json';
  const r = await doJSON('GET', `${acct.endpoint}/console/enterprises/personal/models`, h, undefined, connectTimeoutMs);
  if (r.status >= 400) throw classifyBody(r.status, r.text);
  const data = r.data?.data;
  if (r.data?.code !== 0 || !data || !Array.isArray(data.models) || !data.models.length) {
    throw perr('server', 0, '模型目录为空');
  }
  const cliModels = new Set(data.agents?.cli?.models || []);
  const list = [];
  for (const m of data.models) {
    if (m.disabled || !m.id) continue;
    if (cliModels.size && !cliModels.has(m.id)) continue;
    list.push({
      id: m.id,
      name: m.name || '',
      maxInput: m.maxInputTokens || 0,
      maxOutput: m.maxOutputTokens || 0,
      credits: m.credits || '',
    });
  }
  if (!list.length) throw perr('server', 0, '模型目录为空');
  mcache.set(acct.endpoint, { at: Date.now(), list });
  return list;
}

module.exports = {
  name: 'workbuddy',
  chat,
  models,
  seedModels,
};
