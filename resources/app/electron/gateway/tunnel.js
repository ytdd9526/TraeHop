const net = require('net');

const CONTROL_PORT = 7835;
const NETWORK_TIMEOUT = 3000;
const MAX_FRAME = 4096;
const WARM_IDLE_TTL = 8000;
const WARM_TARGET = 2;
const MAX_WARM = 4;
const WARM_REFRESH = 4000;

function writeFrame(sock, data) {
  return new Promise((resolve, reject) => {
    sock.write(Buffer.concat([Buffer.from(data), Buffer.from([0])]), (err) => (err ? reject(err) : resolve()));
  });
}

function readFrame(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const timer = timeoutMs > 0 ? setTimeout(() => finish(new Error('读取超时')), timeoutMs) : null;
    const onData = (c) => {
      if (done) return;
      let buf = c;
      while (true) {
        const idx = buf.indexOf(0);
        if (idx === -1) {
          size += buf.length;
          if (size > MAX_FRAME) return finish(new Error('帧过长'));
          chunks.push(buf);
          return;
        }
        chunks.push(buf.subarray(0, idx));
        size += idx;
        buf = buf.subarray(idx + 1);
        if (size > MAX_FRAME) return finish(new Error('帧过长'));
        const frame = Buffer.concat(chunks).toString('utf8');
        sock.removeListener('data', onData);
        finish(null, frame);
        if (buf.length) sock.unshift(buf);
        return;
      }
    };
    const onClose = () => finish(new Error('连接已关闭'));
    const onError = (err) => finish(err);
    function finish(err, frame) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('close', onClose);
      sock.removeListener('error', onError);
      if (err) reject(err);
      else resolve(frame);
    }
    sock.on('data', onData);
    sock.on('close', onClose);
    sock.on('error', onError);
  });
}

function parseHello(frame) {
  let m;
  try {
    m = JSON.parse(frame);
  } catch {
    throw new Error(`无法解析握手响应: ${frame}`);
  }
  if (m.Error) throw new Error(`中继错误: ${m.Error}`);
  if (m.Challenge !== undefined) throw new Error('中继要求鉴权（bore.pub 无需鉴权，请检查地址）');
  if (typeof m.Hello === 'number') return m.Hello;
  throw new Error(`握手响应异常: ${frame}`);
}

function parseServerMsg(frame) {
  let s;
  try {
    s = JSON.parse(frame);
  } catch {
    throw new Error(`无法解析消息: ${frame}`);
  }
  if (s === 'Heartbeat') return { kind: 'Heartbeat' };
  if (typeof s === 'string') throw new Error(`未知消息: ${s}`);
  if (s.Connection !== undefined) return { kind: 'Connection', id: String(s.Connection) };
  if (s.Error !== undefined) return { kind: 'Error', msg: String(s.Error) };
  if (s.Challenge !== undefined) return { kind: 'Challenge' };
  if (s.Hello !== undefined) return { kind: 'Hello' };
  throw new Error(`未知消息: ${frame}`);
}

class Tunnel {
  constructor() {
    this.apiPort = 0;
    this.host = 'bore.pub';
    this.state = 'off';
    this.publicURL = '';
    this.errMsg = '';
    this.stopped = true;
    this.warm = [];
    this.warmTimer = null;
  }

  status() {
    return { state: this.state, publicURL: this.publicURL, errMsg: this.errMsg };
  }

  start(apiPort, host) {
    if (this.state === 'starting' || this.state === 'up') return;
    this.apiPort = apiPort;
    this.host = host || 'bore.pub';
    this.state = 'starting';
    this.errMsg = '';
    this.publicURL = '';
    this.stopped = false;
    this.warmTimer = setInterval(() => this.keepWarm(), WARM_REFRESH);
    this.run()
      .then(() => {})
      .catch(() => {});
  }

  stop() {
    this.stopped = true;
    this.state = 'off';
    this.publicURL = '';
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
    this.clearWarm();
  }

  async run() {
    let wasUp = false;
    try {
      const port = await this.dialAndLoop((p) => {
        wasUp = true;
        this.state = 'up';
        this.publicURL = `http://${this.host}:${p}`;
      });
      return port;
    } catch (err) {
      if (this.stopped) {
        this.state = 'off';
        return 0;
      }
      this.state = 'error';
      this.errMsg = err.message;
      if (wasUp) this.publicURL = '';
      throw err;
    } finally {
      if (this.warmTimer) clearInterval(this.warmTimer);
      this.warmTimer = null;
      this.clearWarm();
      if (wasUp && !this.stopped) {
        this.state = 'error';
        this.errMsg = '与中继的连接已断开，可重新开启';
        this.publicURL = '';
      }
    }
  }

  async dialAndLoop(onReady) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (this.stopped) return 0;
      try {
        return await this.dialOnce(onReady);
      } catch (err) {
        if (this.stopped) return 0;
        if (err.upstream) return 0;
        if (attempt === 6) throw new Error(`连接 ${this.host} 反复失败: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return 0;
  }

  async dialOnce(onReady) {
    const conn = await new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: CONTROL_PORT });
      s.setTimeout(6000);
      s.once('connect', () => {
        s.setTimeout(0);
        resolve(s);
      });
      s.once('error', reject);
      s.once('timeout', () => {
        s.destroy();
        reject(new Error(`无法连接 ${this.host}:${CONTROL_PORT}（检查网络）`));
      });
    });
    try {
      await writeFrame(conn, '{"Hello":0}');
      const frame = await readFrame(conn, NETWORK_TIMEOUT * 4);
      const remotePort = parseHello(frame);
      if (onReady) onReady(remotePort);
      this.warmUp(2);
      while (true) {
        if (this.stopped) {
          conn.destroy();
          return remotePort;
        }
        let msgFrame;
        try {
          msgFrame = await readFrame(conn, 0);
        } catch (err) {
          if (this.stopped) return remotePort;
          const e = new Error('与中继的连接已断开，可重新开启');
          e.upstream = true;
          throw e;
        }
        const { kind, id, msg } = parseServerMsg(msgFrame);
        if (kind === 'Heartbeat' || kind === 'Hello') continue;
        if (kind === 'Connection') this.handleConn(id);
        else if (kind === 'Challenge') throw new Error('中继要求鉴权（bore.pub 无需鉴权，请检查地址）');
        else if (kind === 'Error') throw new Error(`中继错误: ${msg}`);
      }
    } catch (err) {
      conn.destroy();
      throw err;
    }
  }

  handleConn(id) {
    this.takeWarm()
      .then((remote) => this.forward(remote, id))
      .catch(() => {});
  }

  async forward(remote, id) {
    try {
      await writeFrame(remote, JSON.stringify({ Accept: id }));
    } catch {
      remote.destroy();
      const r2 = await new Promise((resolve, reject) => {
        const s = net.connect({ host: this.host, port: CONTROL_PORT });
        s.setTimeout(NETWORK_TIMEOUT);
        s.once('connect', () => {
          s.setTimeout(0);
          resolve(s);
        });
        s.once('error', reject);
        s.once('timeout', () => {
          s.destroy();
          reject(new Error('重拨超时'));
        });
      });
      remote = r2;
      try {
        await writeFrame(remote, JSON.stringify({ Accept: id }));
      } catch (err) {
        remote.destroy();
        return;
      }
    }
    this.warmUp(1);
    const local = net.connect({ host: '127.0.0.1', port: this.apiPort });
    local.on('error', () => remote.destroy());
    remote.on('error', () => local.destroy());
    local.on('close', () => remote.destroy());
    remote.on('close', () => local.destroy());
    local.pipe(remote);
    remote.pipe(local);
  }

  takeWarm() {
    while (this.warm.length) {
      const w = this.warm.pop();
      if (Date.now() - w.born < WARM_IDLE_TTL) return Promise.resolve(w.c);
      w.c.destroy();
    }
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: CONTROL_PORT });
      s.setTimeout(NETWORK_TIMEOUT);
      s.once('connect', () => {
        s.setTimeout(0);
        resolve(s);
      });
      s.once('error', reject);
      s.once('timeout', () => {
        s.destroy();
        reject(new Error('转发连接建立失败'));
      });
    });
  }

  warmUp(n) {
    for (let i = 0; i < n; i++) {
      const s = net.connect({ host: this.host, port: CONTROL_PORT });
      s.once('connect', () => {
        if (this.warm.length >= MAX_WARM) {
          s.destroy();
          return;
        }
        this.warm.push({ c: s, born: Date.now() });
      });
      s.once('error', () => {});
    }
  }

  keepWarm() {
    this.warm = this.warm.filter((w) => {
      if (Date.now() - w.born < WARM_IDLE_TTL) return true;
      w.c.destroy();
      return false;
    });
    if (this.warm.length < WARM_TARGET) this.warmUp(WARM_TARGET - this.warm.length);
  }

  clearWarm() {
    for (const w of this.warm) w.c.destroy();
    this.warm = [];
  }
}

module.exports = { Tunnel };
