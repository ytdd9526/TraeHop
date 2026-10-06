
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const accountStore = require('./account-store');
const { readCurrentTraeToken } = require('./trae-reader');
const { parseJwtPayload } = require('./trae-api');
const { getTraeDataPath, isTraeRunning, killTrae, switchTraeAccount } = require('./trae-switcher');
const { ensureDataDir } = require('./data-path');
const { decryptDb, encryptDb, walApply } = require('./sqlcipher-codec');

const PY_SCRIPT = path.join(__dirname, '..', 'tools', 'trae_migrate_sql.py');

function getDbPaths(edition) {
  const dir = path.join(getTraeDataPath(edition), 'ModularData', 'ai-agent');
  return { dir, db: path.join(dir, 'database.db') };
}

function loadKey() {
  let hex = '';
  const keyFile = path.join(ensureDataDir(), 'dbkey.txt');
  if (fs.existsSync(keyFile)) hex = fs.readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    hex = String(accountStore.getSettings().dbKey || '').trim();
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('数据库密钥未配置（userData/dbkey.txt）');
  }
  return Buffer.from(hex, 'hex');
}

function findPython() {
  const candidates = [
    { cmd: 'python', args: [] },
    { cmd: 'py', args: ['-3'] },
    { cmd: 'python3', args: [] },
  ];
  for (const c of candidates) {
    try {
      const out = execFileSync(c.cmd, [...c.args, '--version'], {
        stdio: 'pipe',
        timeout: 15000,
        windowsHide: true,
      });
      if (/Python 3/i.test(String(out))) return c;
    } catch {
      /* try next */
    }
  }
  throw new Error('未找到 Python 3（迁移引擎需要）');
}

function runSqlScript(py, args, stdinData, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(py.cmd, [...py.args, PY_SCRIPT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let buf = '';
    let err = '';
    let resultLine = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('SQL 引擎超时'));
    }, 300000);

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('__RESULT__ ')) resultLine = line.slice(11);
        else if (line) onLog(line);
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!resultLine) {
        reject(new Error('SQL 引擎异常: ' + (err || buf).slice(0, 300)));
        return;
      }
      try {
        resolve(JSON.parse(resultLine));
      } catch {
        reject(new Error('SQL 引擎结果解析失败'));
      }
    });
    if (stdinData) child.stdin.write(stdinData);
    child.stdin.end();
  });
}

async function migrateSessionsToAccount(targetAccountId, onLog = () => {}) {
  const account = accountStore.getAccount(targetAccountId);
  if (!account || !account.userId) throw new Error('账号不存在');
  const toUser = String(account.userId);
  const edition = accountStore.editionOfAccount(account);

  const session = await readCurrentTraeToken(edition);
  const fromUser = String(parseJwtPayload(session.token).userId);
  if (fromUser === toUser) throw new Error('目标账号就是当前登录账号，无需迁移');

  const key = loadKey();
  const { db } = getDbPaths(edition);
  if (!fs.existsSync(db)) throw new Error('未找到对应版本的 Trae 数据库，请先启动一次该版本客户端');

  onLog(`当前账号 ${fromUser} → 目标账号 ${toUser}`);
  if (isTraeRunning(edition)) {
    onLog('关闭对应版本的 Trae IDE…');
    killTrae(edition);
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = `${db}.bak-${stamp}`;
  onLog('备份数据库…');
  fs.copyFileSync(db, bak);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, bak + ext);
  }

  const plain = `${bak}.plain`;
  const enc = `${bak}.enc`;
  const verifyDb = `${bak}.verify`;
  let m; // try/finally 作用域外 return 仍需引用（曾因 const 困在 try 内导致「m is not defined」假报失败）
  let v;
  try {
    onLog('解密数据库…');
    decryptDb(db, plain, key);
    onLog(`  已导出明文库`);

    const wal = `${db}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size > 32) {
      onLog('合并 WAL 日志…');
      try {
        const r = walApply(plain, wal, key);
        onLog(`  帧 ${r.frames}，应用 ${r.applied}，库 ${r.dbsize} 页`);
      } catch (err) {
        throw new Error(`WAL 合并失败: ${err.message}（请正常退出 Trae 后重试）`);
      }
    }

    const py = findPython();
    onLog('迁移项目与会话…');
    m = await runSqlScript(py, ['migrate', plain, fromUser, toUser], null, onLog);
    if (!m.ok) throw new Error(`迁移失败：${m.error}`);
    onLog(`  原生 ${m.native} / 迁入 ${m.migrated} 会话，产物 ${m.artifacts} 条`);

    onLog('重加密…');
    const fd = fs.openSync(db, 'r');
    const salt = Buffer.alloc(16);
    fs.readSync(fd, salt, 0, 16, 0);
    fs.closeSync(fd);
    // 页数在 WAL 合并与迁移写入后必然变化，不能与解密时页数做相等校验；加密库正确性由下方回验闭环保证
    const n2 = encryptDb(plain, enc, key, salt);
    if (n2 < 1) throw new Error('重加密输出为空，中止写回');
    onLog(`  ${n2} 页`);

    onLog('回验加密库…');
    decryptDb(enc, verifyDb, key);
    const oldIds = Object.keys(m.mapping || {});
    v = await runSqlScript(py, ['verify', verifyDb, toUser], `${oldIds.join('\n')}\n`, onLog);
    if (!v.ok) throw new Error(`回验失败：${v.error}`);
    onLog(`  integrity ok，目标账号共 ${v.sessions} 会话`);

    onLog('写回主库…');
    fs.copyFileSync(enc, db);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(db + ext)) fs.unlinkSync(db + ext);
    }
  } finally {
    for (const f of [plain, enc, verifyDb]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }

  onLog('切换到目标账号并重启 Trae…');
  await switchTraeAccount(account);

  return {
    fromUser,
    toUser,
    native: m.native,
    migrated: m.migrated,
    artifacts: m.artifacts,
    sessions: v.sessions,
    backup: bak,
  };
}

module.exports = { migrateSessionsToAccount };
