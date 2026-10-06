const crypto = require('crypto');

function randHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

class OpenAIStreamSink {
  constructor(res, model) {
    this.res = res;
    this.id = 'chatcmpl-' + randHex(12);
    this.created = nowSec();
    this.model = model;
    this.roleSent = false;
    this.wrote = false;
    this.headersSent = false;
  }

  begin() {
    if (this.headersSent) return;
    this.headersSent = true;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  write(payload) {
    this.begin();
    this.wrote = true;
    payload.id = this.id;
    payload.object = 'chat.completion.chunk';
    payload.created = this.created;
    payload.model = this.model;
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  delta(d) {
    const delta = {};
    if (d.role && !this.roleSent) {
      delta.role = d.role;
      this.roleSent = true;
    }
    if (d.content) delta.content = d.content;
    if (d.reasoning) delta.reasoning_content = d.reasoning;
    if (d.tool) {
      const tc = { index: d.tool.index || 0, type: 'function', function: {} };
      if (d.tool.id) tc.id = d.tool.id;
      if (d.tool.name) tc.function.name = d.tool.name;
      if (d.tool.args) tc.function.arguments = d.tool.args;
      delta.tool_calls = [tc];
    }
    if (!Object.keys(delta).length) return;
    this.write({ choices: [{ index: 0, delta }] });
  }

  finish(f) {
    const choice = { index: 0, delta: {}, finish_reason: f.reason || 'stop' };
    const payload = { choices: [choice] };
    if (f.usage && f.usage.present) payload.usage = f.usage;
    this.write(payload);
    this.writeDone();
  }

  streamError(code, msg) {
    this.write({ choices: [], error: { message: msg, code } });
    this.writeDone();
  }

  writeDone() {
    this.begin();
    this.res.write('data: [DONE]\n\n');
  }

  close() {}
}

class AggregateSink {
  constructor(model) {
    this.id = 'chatcmpl-' + randHex(12);
    this.created = nowSec();
    this.model = model;
    this.role = '';
    this.content = '';
    this.reason = '';
    this.tools = new Map();
    this.toolIdxs = [];
    this.finishReason = '';
    this.usage = null;
    this.errCode = 0;
    this.errMsg = '';
  }

  delta(d) {
    if (d.role && !this.role) this.role = d.role;
    if (d.content) this.content += d.content;
    if (d.reasoning) this.reason += d.reasoning;
    if (d.tool) {
      let t = this.tools.get(d.tool.index);
      if (!t) {
        t = { index: d.tool.index || 0, id: '', name: '', args: '' };
        this.tools.set(t.index, t);
        this.toolIdxs.push(t.index);
      }
      if (d.tool.id) t.id = d.tool.id;
      if (d.tool.name) t.name = d.tool.name;
      if (d.tool.args) t.args += d.tool.args;
    }
  }

  finish(f) {
    if (f.reason) this.finishReason = f.reason;
    if (f.usage) this.usage = f.usage;
  }

  streamError(code, msg) {
    this.errCode = code;
    this.errMsg = msg;
  }

  close() {}

  result() {
    if (this.errMsg) return { err: { kind: 'stream', msg: this.errMsg } };
    const message = { role: 'assistant', content: this.content };
    if (this.reason) message.reasoning_content = this.reason;
    if (this.toolIdxs.length) {
      message.tool_calls = [...this.toolIdxs].sort((a, b) => a - b).map((idx) => {
        const t = this.tools.get(idx);
        return { id: t.id, type: 'function', function: { name: t.name, arguments: t.args } };
      });
    }
    const resp = {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason || 'stop' }],
    };
    if (this.usage && this.usage.present) resp.usage = this.usage;
    return { raw: JSON.stringify(resp) };
  }
}

class AnthropicStreamSink {
  constructor(res, model) {
    this.res = res;
    this.model = model;
    this.started = false;
    this.blockOpen = false;
    this.blockIdx = 0;
    this.toolIdxMap = new Map();
    this.usage = null;
    this.wrote = false;
    this.headersSent = false;
  }

  begin() {
    if (this.headersSent) return;
    this.headersSent = true;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
  }

  ev(event, payload) {
    this.begin();
    this.wrote = true;
    payload.type = event;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  ensureStart() {
    if (this.started) return;
    this.started = true;
    this.ev('message_start', {
      message: {
        id: 'msg_' + randHex(12),
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  openBlock(content) {
    this.ensureStart();
    if (this.blockOpen) this.closeBlock();
    const idx = this.blockIdx;
    this.blockIdx++;
    this.blockOpen = true;
    this.ev('content_block_start', { index: idx, content_block: content });
    return idx;
  }

  closeBlock() {
    if (!this.blockOpen) return;
    this.blockOpen = false;
    this.ev('content_block_stop', { index: this.blockIdx - 1 });
  }

  currentOrOpen(content) {
    if (this.blockOpen) return this.blockIdx - 1;
    return this.openBlock(content);
  }

  delta(d) {
    if (d.tool) {
      const known = this.toolIdxMap.get(d.tool.index);
      if (known !== undefined) {
        if (d.tool.args) {
          this.ev('content_block_delta', { index: known, delta: { type: 'input_json_delta', partial_json: d.tool.args } });
        }
        return;
      }
      const blockIdx = this.openBlock({ type: 'tool_use', id: d.tool.id, name: d.tool.name, input: {} });
      this.toolIdxMap.set(d.tool.index, blockIdx);
      if (d.tool.args) {
        this.ev('content_block_delta', { index: blockIdx, delta: { type: 'input_json_delta', partial_json: d.tool.args } });
      }
      return;
    }
    if (d.reasoning) {
      const idx = this.currentOrOpen({ type: 'thinking', thinking: '' });
      this.ev('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: d.reasoning } });
      return;
    }
    if (d.content) {
      const idx = this.currentOrOpen({ type: 'text', text: '' });
      this.ev('content_block_delta', { index: idx, delta: { type: 'text_delta', text: d.content } });
    }
  }

  finish(f) {
    this.closeBlock();
    if (f.usage) this.usage = f.usage;
    const out = this.usage?.completion_tokens || 0;
    const inTok = this.usage?.prompt_tokens || 0;
    this.ensureStart();
    this.ev('message_delta', {
      delta: { stop_reason: anthropicStop(f.reason), stop_sequence: null },
      usage: { output_tokens: out, input_tokens: inTok },
    });
    this.ev('message_stop', {});
  }

  streamError(code, msg) {
    this.ensureStart();
    this.ev('error', { error: { type: 'api_error', message: msg } });
  }

  close() {}
}

class AnthropicAggregateSink {
  constructor(model) {
    this.inner = new AggregateSink(model);
    this.model = model;
  }

  delta(d) { this.inner.delta(d); }
  finish(f) { this.inner.finish(f); }
  streamError(c, m) { this.inner.streamError(c, m); }
  close() {}

  result() {
    const { raw, err } = this.inner.result();
    if (err) return { err };
    const resp = JSON.parse(raw);
    const choice = resp.choices?.[0] || {};
    const msg = choice.message || {};
    const content = [];
    if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: '' });
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const tc of msg.tool_calls || []) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    const usage = { input_tokens: 0, output_tokens: 0 };
    if (resp.usage) {
      usage.input_tokens = resp.usage.prompt_tokens || 0;
      usage.output_tokens = resp.usage.completion_tokens || 0;
    }
    const out = {
      id: 'msg_' + randHex(12),
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: anthropicStop(choice.finish_reason),
      stop_sequence: null,
      usage,
    };
    return { raw: JSON.stringify(out) };
  }
}

class UsageRecorder {
  constructor(inner) {
    this.inner = inner;
    this.usage = null;
  }

  delta(d) { this.inner.delta(d); }
  streamError(c, m) { this.inner.streamError(c, m); }
  close() { this.inner.close(); }
  get wrote() { return this.inner.wrote || false; }

  finish(f) {
    if (f.usage) this.usage = f.usage;
    this.inner.finish(f);
  }

  tokens() {
    if (!this.usage?.present) return 0;
    if (this.usage.total_tokens > 0) return this.usage.total_tokens;
    return this.usage.prompt_tokens + this.usage.completion_tokens;
  }

  pc() {
    if (!this.usage?.present) return { prompt: 0, completion: 0, total: 0 };
    return {
      prompt: this.usage.prompt_tokens || 0,
      completion: this.usage.completion_tokens || 0,
      total: (this.usage.prompt_tokens || 0) + (this.usage.completion_tokens || 0),
    };
  }
}

function anthropicStop(r) {
  if (r === 'length') return 'max_tokens';
  if (r === 'tool_calls') return 'tool_use';
  if (r === 'content_filter') return 'refusal';
  return 'end_turn';
}

module.exports = {
  OpenAIStreamSink,
  AggregateSink,
  AnthropicStreamSink,
  AnthropicAggregateSink,
  UsageRecorder,
  anthropicStop,
};
