const http = require('http');
const net = require('net');
const { perr, asPerr, KIND_AUTH, KIND_QUOTA, KIND_RATE, KIND_CLIENT, KIND_MODEL, KIND_SERVER } = require('./errors');
const {
  OpenAIStreamSink,
  AggregateSink,
  AnthropicStreamSink,
  AnthropicAggregateSink,
  UsageRecorder,
} = require('./sinks');
const shares = require('./shares');
const usagelog = require('./usagelog');

const BODY_LIMIT = 20 << 20;
const VERSION = '1.0.0';

function writeJSON(res, status, obj) {
  const raw = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(raw) });
  res.end(raw);
}

function writeOpenAIError(res, status, code, msg) {
  writeJSON(res, status, { error: { message: msg, type: code, code } });
}

function writeAnthropicError(res, status, typ, msg) {
  writeJSON(res, status, { type: 'error', error: { type: typ, message: msg } });
}

function bearerKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-api-key'] || '').trim();
}

function mapClientStatus(pe) {
  if (pe.kind === KIND_AUTH || pe.kind === KIND_QUOTA) return 502;
  if (pe.kind === KIND_RATE) return 429;
  if (pe.kind === KIND_CLIENT) return pe.status >= 400 && pe.status < 500 ? pe.status : 400;
  if (pe.kind === KIND_MODEL) return 404;
  if (pe.kind === KIND_SERVER) return pe.status >= 400 ? pe.status : 502;
  return pe.status >= 400 ? pe.status : 502;
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function systemText(sys) {
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

function blocksToOpenAI(content, isUser) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  const toolMsgs = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source?.type === 'base64') {
      out.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data || ''}` } });
    } else if (isUser && b.type === 'tool_result') {
      let text = '';
      if (typeof b.content === 'string') text = b.content;
      else if (Array.isArray(b.content)) {
        text = b.content.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('');
      }
      toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: text });
    }
  }
  if (isUser && toolMsgs.length) return [...out, ...toolMsgs];
  if (out.length === 1 && out[0].type === 'text') return out[0].text;
  return out;
}

function anthropicToOpenAI(src) {
  const out = { model: src.model, stream: src.stream };
  if (typeof src.max_tokens === 'number') out.max_tokens = src.max_tokens;
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.top_p === 'number') out.top_p = src.top_p;
  if (Array.isArray(src.stop_sequences)) out.stop = src.stop_sequences;
  const messages = [];
  if (src.system != null) {
    const text = systemText(src.system);
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const m of Array.isArray(src.messages) ? src.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      messages.push({ role: 'user', content: blocksToOpenAI(m.content, true) });
    } else if (m.role === 'assistant') {
      const om = { role: 'assistant', content: blocksToOpenAI(m.content, false) };
      const toolCalls = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b && b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || '',
            type: 'function',
            function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) },
          });
        }
      }
      if (toolCalls.length) {
        om.tool_calls = toolCalls;
        if (om.content === '') om.content = null;
      }
      messages.push(om);
    }
  }
  out.messages = messages;
  if (Array.isArray(src.tools) && src.tools.length) {
    const otools = [];
    for (const t of src.tools) {
      if (!t || typeof t !== 'object') continue;
      otools.push({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      });
    }
    if (otools.length) out.tools = otools;
  }
  if (src.tool_choice && typeof src.tool_choice === 'object') {
    if (src.tool_choice.type === 'auto') out.tool_choice = 'auto';
    else if (src.tool_choice.type === 'any') out.tool_choice = 'required';
    else if (src.tool_choice.type === 'tool' && src.tool_choice.name) {
      out.tool_choice = { type: 'function', function: { name: src.tool_choice.name } };
    }
  }
  return out;
}

function countTokensText(src) {
  let text = systemText(src?.system);
  for (const m of Array.isArray(src?.messages) ? src.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string') text += m.content;
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b.text === 'string') text += b.text;
      }
    }
  }
  return text;
}

function localIP() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '8.8.8.8', port: 80 });
    s.on('connect', () => {
      const ip = s.localAddress;
      s.destroy();
      resolve(ip || '127.0.0.1');
    });
    s.on('error', () => resolve('127.0.0.1'));
    setTimeout(() => {
      s.destroy();
      resolve('127.0.0.1');
    }, 1500);
  });
}

class Server {
  constructor({ getConfig, pool, appVersion }) {
    this.getConfig = getConfig;
    this.pool = pool;
    this.appVersion = appVersion || VERSION;
    this.httpServer = null;
    this.port = 0;
    this.warmTimer = null;
    this.routes = {
      'POST /v1/chat/completions': { fn: (req, res, ctx) => this.handleChat(req, res, ctx) },
      'POST /chat/completions': { fn: (req, res, ctx) => this.handleChat(req, res, ctx) },
      'POST /v1/completions': { fn: (req, res, ctx) => this.handleChat(req, res, ctx) },
      'POST /completions': { fn: (req, res, ctx) => this.handleChat(req, res, ctx) },
      'GET /v1/models': { fn: (req, res) => this.handleModels(req, res) },
      'GET /models': { fn: (req, res) => this.handleModels(req, res) },
      'POST /v1/messages': { fn: (req, res, ctx) => this.handleMessages(req, res, ctx) },
      'POST /messages': { fn: (req, res, ctx) => this.handleMessages(req, res, ctx) },
      'POST /v1/messages/count_tokens': { fn: (req, res) => this.handleCountTokens(req, res) },
      'POST /messages/count_tokens': { fn: (req, res) => this.handleCountTokens(req, res) },
      'GET /status': { fn: (req, res) => this.handleStatus(req, res), ownerOnly: true },
      'GET /healthz': { fn: (req, res) => this.handleHealth(req, res), noAuth: true },
    };
  }

  async listen() {
    const cfg = this.getConfig();
    let port = cfg.port;
    for (let i = 0; i < 20; i++) {
      const ok = await tryPort(cfg.host, port);
      if (ok) break;
      port++;
    }
    this.port = port;
    await new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this.route(req, res));
      this.httpServer.on('error', reject);
      this.httpServer.listen(port, cfg.host, resolve);
    });
    this.warmTimer = setInterval(() => this.warm(), 60000);
    this.warm();
    const ip = await localIP();
    return { host: cfg.host, port, lan: `http://${ip}:${port}` };
  }

  close() {
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
    return new Promise((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
      this.httpServer = null;
    });
  }

  warm() {
    for (const host of ['trae-api-cn.mchost.guru']) {
      const s = net.connect({ host, port: 443 });
      s.on('connect', () => s.destroy());
      s.on('error', () => {});
      setTimeout(() => s.destroy(), 5000);
    }
  }

  route(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key, anthropic-version',
      });
      res.end();
      return;
    }
    const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    const key = `${req.method} ${url}`;
    const h = this.routes[key];
    if (!h) {
      writeJSON(res, 404, { error: { message: `未知路由 ${key}`, type: 'not_found', code: 'not_found' } });
      return;
    }
    const auth = h.noAuth ? { ok: true, share: null } : this.authorize(req, res);
    if (!auth.ok) return;
    const ctx = { share: auth.share };
    if (h.ownerOnly && ctx.share) {
      writeOpenAIError(res, 403, 'forbidden', '该端点不对分享钥匙开放。');
      return;
    }
    Promise.resolve(h.fn(req, res, ctx)).catch((err) => {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', err.message || '内部错误');
      else res.end();
    });
  }

  authorize(req, res) {
    const cfg = this.getConfig();
    const key = bearerKey(req);
    if (!key) {
      writeOpenAIError(res, 401, 'invalid_api_key', '缺少 API key。请求头需携带 Authorization: Bearer <key>，或到面板查看正确的 key。');
      return { ok: false };
    }
    if (key === cfg.apiKey) return { ok: true, share: null };
    const s = shares.resolve(key);
    if (s) {
      if (!s.enabled) {
        writeOpenAIError(res, 403, 'share_disabled', '该分享钥匙已被停用。');
        return { ok: false };
      }
      return { ok: true, share: { id: s.id, name: s.name } };
    }
    writeOpenAIError(res, 401, 'invalid_api_key', 'API key 无效。请在请求头携带 Authorization: Bearer <key>，或到面板查看正确的 key。');
    return { ok: false };
  }

  logUsage(ctx, model, provName, start, rec, err) {
    const p = rec ? rec.pc() : { prompt: 0, completion: 0, total: 0 };
    usagelog.add({
      time: Math.floor(Date.now() / 1000),
      caller: ctx.share ? ctx.share.name : '',
      provider: provName,
      model,
      promptTokens: p.prompt,
      completionTokens: p.completion,
      totalTokens: p.total,
      durationMs: Date.now() - start,
      ok: !err,
      errMsg: err ? asPerr(err).message : '',
    });
  }

  async handleChat(req, res, ctx) {
    const body = await readBody(req);
    let peek = {};
    try {
      peek = JSON.parse(body);
    } catch {
      peek = {};
    }
    const model = typeof peek.model === 'string' ? peek.model : '';
    const { name, bare } = this.pool.resolveModel(model);
    const prov = this.pool.provider(name);
    if (!prov) {
      writeOpenAIError(res, 503, 'no_provider', '没有可用提供商');
      return;
    }
    if (ctx.share) {
      const checkModel = bare || model;
      const msg = shares.authorize(ctx.share.id, name, checkModel);
      if (msg) {
        writeOpenAIError(res, 429, 'share_limit', msg);
        return;
      }
    }
    const outModel = bare || model;
    const start = Date.now();
    if (peek.stream) {
      const sink = new UsageRecorder(new OpenAIStreamSink(res, outModel));
      let err = null;
      try {
        await this.pool.chat(model, body, sink);
      } catch (e) {
        err = e;
      }
      if (ctx.share) shares.record(ctx.share.id, name, sink.tokens());
      this.logUsage(ctx, model, name, start, sink, err);
      if (err && !sink.wrote) {
        const pe = asPerr(err);
        writeOpenAIError(res, mapClientStatus(pe), pe.kind, pe.message);
        return;
      }
      res.end();
      return;
    }
    const sink = new UsageRecorder(new AggregateSink(outModel));
    let err = null;
    try {
      await this.pool.chat(model, body, sink);
    } catch (e) {
      err = e;
    }
    if (ctx.share) shares.record(ctx.share.id, name, sink.tokens());
    this.logUsage(ctx, model, name, start, sink, err);
    if (err) {
      const pe = asPerr(err);
      writeOpenAIError(res, mapClientStatus(pe), pe.kind, pe.message);
      return;
    }
    const { raw, err: rerr } = sink.inner.result();
    if (rerr) {
      writeOpenAIError(res, mapClientStatus(perr(rerr.kind, 0, rerr.msg)), rerr.kind, rerr.msg);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(raw);
  }

  async handleMessages(req, res, ctx) {
    const body = await readBody(req);
    let src = null;
    try {
      src = JSON.parse(body);
    } catch {
      writeAnthropicError(res, 400, 'invalid_request_error', '请求不是合法 JSON');
      return;
    }
    const model = typeof src.model === 'string' ? src.model : '';
    const { name, bare } = this.pool.resolveModel(model);
    const prov = this.pool.provider(name);
    if (!prov) {
      writeAnthropicError(res, 503, 'api_error', '没有可用提供商');
      return;
    }
    if (ctx.share) {
      const checkModel = bare || model;
      const msg = shares.authorize(ctx.share.id, name, checkModel);
      if (msg) {
        writeAnthropicError(res, 429, 'rate_limit_error', msg);
        return;
      }
    }
    const outModel = bare || model;
    const openaiReq = JSON.stringify(anthropicToOpenAI(src));
    const start = Date.now();
    if (src.stream) {
      const sink = new UsageRecorder(new AnthropicStreamSink(res, outModel));
      let err = null;
      try {
        await this.pool.chat(model, openaiReq, sink);
      } catch (e) {
        err = e;
      }
      if (ctx.share) shares.record(ctx.share.id, name, sink.tokens());
      this.logUsage(ctx, model, name, start, sink, err);
      if (err && !sink.wrote) {
        const pe = asPerr(err);
        writeAnthropicError(res, mapClientStatus(pe), 'api_error', pe.message);
        return;
      }
      res.end();
      return;
    }
    const sink = new UsageRecorder(new AnthropicAggregateSink(outModel));
    let err = null;
    try {
      await this.pool.chat(model, openaiReq, sink);
    } catch (e) {
      err = e;
    }
    if (ctx.share) shares.record(ctx.share.id, name, sink.tokens());
    this.logUsage(ctx, model, name, start, sink, err);
    if (err) {
      const pe = asPerr(err);
      writeAnthropicError(res, mapClientStatus(pe), 'api_error', pe.message);
      return;
    }
    const { raw, err: rerr } = sink.inner.result();
    if (rerr) {
      writeAnthropicError(res, mapClientStatus(perr(rerr.kind, 0, rerr.msg)), 'api_error', rerr.msg);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(raw);
  }

  async handleModels(req, res) {
    const cfg = this.getConfig();
    const all = await this.pool.allModels();
    const data = [];
    const seen = new Set();
    const addModel = (id, owner) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      data.push({ id, object: 'model', owned_by: owner });
    };
    const order = [cfg.defaultProvider, ...this.pool.providerNames().filter((n) => n !== cfg.defaultProvider)];
    for (const name of order) {
      for (const m of all[name] || []) {
        addModel(m.id, name);
        if (cfg.exposePrefixModels) addModel(`${name}:${m.id}`, name);
      }
    }
    writeJSON(res, 200, { object: 'list', data });
  }

  async handleCountTokens(req, res) {
    const body = await readBody(req);
    let src = {};
    try {
      src = JSON.parse(body);
    } catch {
      src = {};
    }
    const text = countTokensText(src);
    const est = Math.floor([...text].length / 2 + text.length / 6);
    writeJSON(res, 200, { input_tokens: est });
  }

  async handleStatus(req, res) {
    writeJSON(res, 200, {
      service: 'TraeHop Gateway',
      version: this.appVersion,
      port: this.port,
      accounts: this.pool.status(),
    });
  }

  handleHealth(req, res) {
    writeJSON(res, 200, { ok: true });
  }
}

function tryPort(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

module.exports = { Server, localIP, anthropicToOpenAI, systemText, blocksToOpenAI };
