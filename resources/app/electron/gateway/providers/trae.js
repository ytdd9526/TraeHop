const crypto = require('crypto');
const { doJSON, doStream, readBody } = require('../httpx');
const { scanSSE } = require('../sse');
const { perr, classifyBody, KIND_QUOTA, KIND_NETWORK, KIND_STREAM } = require('../errors');

const ClientID = 'en1oxy7wnw8j9n';
const AppID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IdeVersion = '0.1.52';
const IdeVersionCode = '20260811';
const DeviceBrand = '83DG';
const OSVersion = 'Windows 11 Pro';
const Function = 'solo_work_lite';
const UA = `Trae/${IdeVersion}`;
const AgentBase = 'https://trae-api-cn.mchost.guru';

const seedModels = [
  'glm-5.2', 'glm-5-turbo', 'glm-5',
  'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.1-Turbo',
  'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash',
  'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6',
  'minimax-m3', 'qwen-3.7-plus',
].map((id) => ({ id }));

function deriveDeviceId(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  const n = h.readBigUInt64BE(0) % 9000000000000000n + 1000000000000000n;
  return String(n);
}

function soloHeaders(acct) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': UA,
    'X-Cloudide-Token': acct.token,
    'X-Ide-Token': acct.token,
    'X-App-Id': AppID,
    'X-App-Version': 'default',
    'X-Ide-Version': IdeVersion,
    'X-Ide-Version-Code': IdeVersionCode,
    'X-App-Version-Code': IdeVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': OSVersion,
    'X-Device-Brand': DeviceBrand,
    'Request-Traffic-Type': 'prod',
    Authorization: `Cloud-IDE-JWT ${acct.token}`,
  };
  if (acct.uid) h['X-Uid'] = String(acct.uid);
  if (acct.machineId) h['X-Machine-Id'] = String(acct.machineId);
  if (acct.deviceId) h['X-Device-Id'] = String(acct.deviceId);
  return h;
}

function normalizeToolChoice(tc) {
  if (typeof tc === 'string') {
    if (tc === 'none') return { drop: true };
    return { value: tc };
  }
  if (tc && typeof tc === 'object') {
    const typ = tc.type;
    if (typ === 'none') return { drop: true };
    if (typ === 'function' && tc.function?.name) return { value: tc.function.name };
    if (typ === 'function') return { value: 'auto' };
    if (typ) return { value: typ };
  }
  return { value: 'auto' };
}

function normalizeMessages(msgs) {
  return msgs.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const out = { ...m };
    if (out.role === 'developer') out.role = 'system';
    if (out.role === 'assistant' && Array.isArray(out.tool_calls)) {
      const converted = out.tool_calls
        .map((c) => (c?.function?.name ? { id: c.id, type: c.type, function_call: c.function } : null))
        .filter(Boolean);
      if (converted.length) out.tool_calls = converted;
      else delete out.tool_calls;
    }
    if (typeof out.content === 'string') {
      out.content = [{ type: 'text', text: out.content }];
    }
    return out;
  });
}

function prepareSOLO(openaiReq, defaultModel) {
  let src;
  try {
    src = JSON.parse(openaiReq);
  } catch (err) {
    throw perr('client', 400, `请求不是合法 JSON: ${err.message}`);
  }
  const b = src && typeof src === 'object' ? src : {};
  b.stream = true;
  b.function = Function;
  let model = typeof b.model === 'string' ? b.model : '';
  if (!model.trim()) model = defaultModel;
  b.model = model;
  b.config_name = model;
  if (Array.isArray(b.messages)) b.messages = normalizeMessages(b.messages);
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
  if (Array.isArray(b.tools)) {
    for (const t of b.tools) {
      const fn = t?.function;
      if (fn && fn.parameters && typeof fn.parameters !== 'string') {
        fn.parameters = JSON.stringify(fn.parameters);
      }
    }
  }
  return b;
}

function classifyTrae(status, text) {
  const e = classifyBody(status, text);
  let probe = null;
  try {
    probe = JSON.parse(text);
  } catch {
    probe = null;
  }
  if (probe && probe.code === 1005) return perr(KIND_QUOTA, status, probe.msg || '套餐次数用尽');
  return e;
}

async function chat(acct, openaiReq, defaultModel, sink, connectTimeoutMs) {
  const body = prepareSOLO(openaiReq, defaultModel);
  let res;
  try {
    res = await doStream('POST', `${AgentBase}/api/agent/v3/llm_utils_chat`, soloHeaders(acct), body, connectTimeoutMs);
  } catch (err) {
    sink.close();
    throw perr(KIND_NETWORK, 0, err.message);
  }
  if (res.statusCode >= 400) {
    const text = await readBody(res);
    sink.close();
    throw classifyTrae(res.statusCode, text);
  }
  const ct = res.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    const text = await readBody(res);
    sink.close();
    throw classifyTrae(res.statusCode, text);
  }
  return streamSOLO(res, sink);
}

async function streamSOLO(res, sink) {
  let usage = null;
  let finish = '';
  let hasDelta = false;
  let streamErr = null;
  try {
    await scanSSE(res, (ev) => {
      switch (ev.event) {
        case 'output': {
          let out;
          try {
            out = JSON.parse(ev.data);
          } catch {
            return true;
          }
          if (out.response || out.reasoning_content) {
            hasDelta = true;
            sink.delta({ content: out.response || '', reasoning: out.reasoning_content || '' });
          }
          if (out.tool_calls && out.tool_calls !== 'null') {
            emitToolCalls(out.tool_calls, sink, () => { hasDelta = true; });
          }
          return true;
        }
        case 'token_usage': {
          try {
            const u = JSON.parse(ev.data);
            usage = {
              present: true,
              prompt_tokens: numAsInt(u.prompt_tokens),
              completion_tokens: numAsInt(u.completion_tokens),
              total_tokens: numAsInt(u.total_tokens),
            };
          } catch {
            /* 忽略不可解析的用量帧 */
          }
          return true;
        }
        case 'done': {
          try {
            const d = JSON.parse(ev.data);
            finish = d.finish_reason || '';
          } catch {
            finish = '';
          }
          return false;
        }
        case 'error': {
          let e = {};
          try {
            e = JSON.parse(ev.data);
          } catch {
            e = {};
          }
          streamErr = perr(KIND_STREAM, 0, `code=${e.code || 0} ${e.message || ''}`.trim());
          return false;
        }
        default:
          return true;
      }
    });
  } finally {
    res.destroy();
  }
  if (streamErr) throw streamErr;
  if (!finish) {
    finish = 'stop';
    if (!hasDelta) sink.streamError(0, '上游返回空流');
  }
  sink.finish({ reason: finish, usage });
}

function emitToolCalls(raw, sink, mark) {
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object') arr = [raw];
  else return;
  for (const call of arr) {
    if (!call || typeof call !== 'object') continue;
    const td = {
      index: Number(call.index) || 0,
      id: typeof call.id === 'string' ? call.id : '',
      name: '',
      args: '',
    };
    const fn = call.function || call.function_call;
    if (fn && typeof fn === 'object') {
      if (typeof fn.name === 'string') td.name = fn.name;
      if (typeof fn.arguments === 'string') td.args = fn.arguments;
    }
    mark();
    sink.delta({ tool: td });
  }
}

function numAsInt(v) {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? Math.trunc(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

let modelsCache = null;
let modelsCacheAt = 0;

async function models(acct, connectTimeoutMs) {
  if (modelsCache && Date.now() - modelsCacheAt < 3600000) return modelsCache;
  const body = {
    function: Function,
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null,
  };
  const r = await doJSON('POST', `${AgentBase}/api/ide/v1/get_detail_param`, soloHeaders(acct), body, connectTimeoutMs);
  if (r.status >= 400) throw classifyTrae(r.status, r.text);
  const list = [];
  for (const c of r.data?.config_info_list || []) {
    if (!c.config_name) continue;
    list.push({ id: c.config_name, name: c.display_config?.display_name || '' });
  }
  if (!list.length) throw perr('server', 0, '模型列表为空');
  modelsCache = list;
  modelsCacheAt = Date.now();
  return list;
}

module.exports = {
  name: 'trae',
  chat,
  models,
  seedModels,
  deriveDeviceId,
};
