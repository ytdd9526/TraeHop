const https = require('https');
const http = require('http');
const { URL } = require('url');

const agents = {
  https: new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8, keepAliveMsecs: 30000 }),
  http: new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8, keepAliveMsecs: 30000 }),
};

function buildRequest(method, url, headers, body) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const h = { ...(headers || {}) };
  if (body !== undefined && body !== null && !Object.keys(h).some((k) => k.toLowerCase() === 'content-length')) {
    h['Content-Length'] = Buffer.byteLength(body);
  }
  return lib.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    method,
    headers: h,
    agent: u.protocol === 'http:' ? agents.http : agents.https,
  });
}

function send(req, body, headerTimeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = headerTimeoutMs > 0
      ? setTimeout(() => req.destroy(new Error(`连接超时 (${headerTimeoutMs}ms)`)), headerTimeoutMs)
      : null;
    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    req.on('response', (res) => {
      if (timer) clearTimeout(timer);
      resolve(res);
    });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

async function doJSON(method, url, headers, body, totalTimeoutMs) {
  const payload = body === undefined || body === null ? undefined : JSON.stringify(body);
  const res = await send(buildRequest(method, url, headers, payload), payload, totalTimeoutMs);
  const timer = totalTimeoutMs > 0 ? setTimeout(() => res.destroy(new Error(`请求超时 (${totalTimeoutMs}ms)`)), totalTimeoutMs) : null;
  const chunks = [];
  try {
    for await (const c of res) chunks.push(c);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let data = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  return { status: res.statusCode, text, data };
}

// headerTimeoutMs 只限制响应头到达；到达后拆除定时器，SSE 流不受任何超时影响。
async function doStream(method, url, headers, body, headerTimeoutMs) {
  const payload = body === undefined || body === null ? undefined : JSON.stringify(body);
  return send(buildRequest(method, url, headers, payload), payload, headerTimeoutMs);
}

function readBody(res, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

module.exports = { doJSON, doStream, readBody };
