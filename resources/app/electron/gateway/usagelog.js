const fs = require('fs');
const path = require('path');
const { getStableDataDir } = require('../data-path');

const FILE = path.join(getStableDataDir(), 'gateway', 'usagelog.json');
const MAX = 500;

let entries = null;

function load() {
  if (entries) return entries;
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    entries = Array.isArray(v.entries) ? v.entries : [];
  } catch {
    entries = [];
  }
  return entries;
}

function add(e) {
  const list = load();
  list.unshift({
    time: e.time || Math.floor(Date.now() / 1000),
    caller: e.caller || '',
    provider: e.provider || '',
    model: e.model || '',
    promptTokens: e.promptTokens || 0,
    completionTokens: e.completionTokens || 0,
    totalTokens: e.totalTokens || 0,
    durationMs: e.durationMs || 0,
    ok: e.ok !== false,
    errMsg: e.errMsg || '',
  });
  if (list.length > MAX) list.length = MAX;
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries: list }, null, 1));
  fs.renameSync(tmp, FILE);
}

function list(limit) {
  const all = load();
  const n = limit > 0 && limit < MAX ? limit : MAX;
  return all.slice(0, n).map((e) => ({ ...e }));
}

module.exports = { add, list, MAX };
