const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { getPlatformConfig, CLIENTS } = require('./platform-config');
const { getTraePath, editionOfAccount, setAccountMachineId } = require('./account-store');
const { encryptString, decryptString } = require('./trae-byte-crypto');

const AUTH_PROVIDER_ID = 'icube.cloudide';
const AUTH_KEY = `iCubeAuthInfo://${AUTH_PROVIDER_ID}`;
const ENTITLEMENT_KEY = `iCubeEntitlementInfo://${AUTH_PROVIDER_ID}`;
const SERVER_KEY = `iCubeServerData://${AUTH_PROVIDER_ID}`;
const USERTAG_KEY = 'iCubeAuthInfo://usertag';
const LOGIN_STORAGE_KEYS = [AUTH_KEY, ENTITLEMENT_KEY, SERVER_KEY, USERTAG_KEY];

function generateMachineId() {
  return crypto.randomUUID();
}

// Windows 无 sleep 命令，execSync('sleep') 会直接抛错；用 Atomics.wait 做同步等待
function syncSleep(sec) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec * 1000);
}

function md5TelemetryId(input) {
  const h1 = crypto.createHash('sha256').update(input).digest();
  const h2 = crypto.createHash('sha256').update(input + h1.toString('hex')).digest();
  const combined = Buffer.concat([h1.subarray(0, 8), h2.subarray(0, 8)]);
  return combined.toString('hex');
}

// Windows job object：从 Trae 终端树内启动的进程会随 Trae 关闭被系统连坐杀掉，
// 导致迁移/切换死在半路（Trae 关了但没重启、没切账号）。杀 Trae 前先自检。
function findTraeAncestor() {
  if (process.platform !== 'win32') return null;
  const exeNames = Object.values(CLIENTS).flatMap((c) => c.dirs.map((d) => `${d}.exe`));
  const ps = [
    '$ProgressPreference = "SilentlyContinue"',
    `$ancestors = @(${exeNames.map((n) => `'${n}'`).join(',')})`,
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}"`,
    'for ($i = 0; $i -lt 8 -and $p; $i++) {',
    '  if ($ancestors -contains $p.Name) { Write-Output $p.Name; exit }',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"',
    '}',
  ].join('\n');
  try {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const line = (out || '').split(/\r?\n/).map((l) => l.trim()).find((l) => exeNames.includes(l));
    return line || null; // 行级精确匹配，防 CLIXML/progress 噪音
  } catch {
    return null; // 检测失败不阻断操作
  }
}

function applyTelemetryIds(json, machineId) {
  json['telemetry.machineId'] = md5TelemetryId(machineId);
  json['telemetry.sqmId'] = `{${generateMachineId().toUpperCase()}}`;
  json['telemetry.devDeviceId'] = generateMachineId();
}

function readStorageJson(traePath) {
  const storagePath = path.join(traePath, 'User', 'globalStorage', 'storage.json');
  if (!fs.existsSync(storagePath)) return { json: null, storagePath };
  try {
    return { json: JSON.parse(fs.readFileSync(storagePath, 'utf8')), storagePath };
  } catch {
    return { json: null, storagePath };
  }
}

function targetEditions(edition) {
  return edition === 'intl' ? ['intl'] : edition === 'cn' ? ['cn'] : ['cn', 'intl'];
}

function clientExeNames(edition) {
  return CLIENTS[edition === 'intl' ? 'intl' : 'cn'].dirs.map((d) => `${d}.exe`);
}

function getTraeDataPath(edition) {
  const config = getPlatformConfig(edition);
  if (!config) throw new Error('仅支持 macOS 和 Windows');
  return config.appSupportBase;
}

function isTraeRunning(edition) {
  for (const ed of targetEditions(edition)) {
    for (const exe of clientExeNames(ed)) {
      if (process.platform === 'darwin') {
        try {
          execSync(`pgrep -f "${exe.replace(/\.exe$/, '')}.app/Contents/MacOS"`, { stdio: 'ignore' });
          return true;
        } catch {
          /* continue */
        }
      } else if (process.platform === 'win32') {
        try {
          const out = execSync(`tasklist /FI "IMAGENAME eq ${exe}" /NH`, { encoding: 'utf8' });
          if (out.includes(exe)) return true;
        } catch {
          /* continue */
        }
      }
    }
  }
  return false;
}

function killTrae(edition) {
  if (!isTraeRunning(edition)) return;

  const ancestor = findTraeAncestor();
  if (ancestor) {
    throw new Error(`本程序正运行在 ${ancestor} 的进程树内，关闭 Trae 时会被系统连坐中断。请从桌面独立启动鬼鬼聚合后重试`);
  }

  const exeList = targetEditions(edition).flatMap((ed) => clientExeNames(ed));

  for (const exe of exeList) {
    if (process.platform === 'darwin') {
      try {
        execSync(`osascript -e 'tell application "${exe.replace(/\.exe$/, '')}" to quit'`, { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    } else if (process.platform === 'win32') {
      try {
        execSync(`taskkill /IM "${exe}"`, { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
  }

  syncSleep(1.5);

  if (isTraeRunning(edition)) {
    for (const exe of exeList) {
      if (process.platform === 'darwin') {
        try {
          execSync(`pkill -9 -f "${exe.replace(/\.exe$/, '')}.app/Contents/MacOS"`, { stdio: 'ignore' });
        } catch {
          /* ignore */
        }
      } else if (process.platform === 'win32') {
        try {
          execSync(`taskkill /F /IM "${exe}"`, { stdio: 'ignore' });
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (isTraeRunning(edition)) {
    throw new Error('无法关闭对应版本的 Trae IDE，请手动关闭后重试');
  }
}

function removeIfExists(targetPath, isDir = false) {
  if (!fs.existsSync(targetPath)) return;
  if (isDir) fs.rmSync(targetPath, { recursive: true, force: true });
  else fs.unlinkSync(targetPath);
}

function buildUserInfo(account) {
  const now = new Date();
  const expiredAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const refreshExpiredAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  const region = (account.region || 'SG').toUpperCase();
  const host =
    region === 'CN'
      ? 'https://api.trae.com.cn'
      : region === 'US'
        ? 'https://api-us-east.trae.ai'
        : 'https://api-sg-central.trae.ai';

  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z');

  return {
    token: account.token,
    refreshToken: account.refreshToken || '',
    expiredAt: fmt(expiredAt),
    refreshExpiredAt: fmt(refreshExpiredAt),
    tokenReleaseAt: fmt(now),
    userId: account.userId,
    host,
    userRegion: { region, _aiRegion: region },
    account: {
      username: account.name,
      iss: '',
      iat: 0,
      organization: '',
      work_country: '',
      email: account.email,
      avatar_url: account.avatarUrl || '',
      description: '',
      scope: 'marscode',
      loginScope: 'trae',
      storeCountryCode: 'cn',
      storeCountrySrc: 'uid',
      storeRegion: region,
      userTag: 'row',
    },
  };
}

function buildEntitlementInfo() {
  return {
    identityStr: 'Free',
    identity: 0,
    isPayFreshman: false,
    isSupportCommercialization: true,
    hasPackage: false,
    enableEntitlement: true,
    detail: {
      can_gen_solo_code: false,
      fast_request_per: 1,
      in_wait: false,
      permission: 1,
      toast_read: false,
      toastRead: false,
      canGenSoloCode: false,
      fastRequestPer: 1,
      inWaitlist: false,
    },
  };
}

async function writeTraeLoginInfo(traePath, account) {
  const storageDir = path.join(traePath, 'User', 'globalStorage');
  fs.mkdirSync(storageDir, { recursive: true });
  const storagePath = path.join(storageDir, 'storage.json');

  let json = {};
  if (fs.existsSync(storagePath)) {
    try {
      json = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    } catch {
      json = {};
    }
  }

  if (account.encryptedAuth && account.encryptedAuth.startsWith('dGMF')) {
    json[AUTH_KEY] = account.encryptedAuth;
  } else {
    const userInfo = buildUserInfo(account);
    json[AUTH_KEY] = await encryptString(JSON.stringify(userInfo));
  }

  if (account.encryptedEntitlement && account.encryptedEntitlement.startsWith('dGMF')) {
    json[ENTITLEMENT_KEY] = account.encryptedEntitlement;
  } else {
    json[ENTITLEMENT_KEY] = await encryptString(JSON.stringify(buildEntitlementInfo()));
  }

  if (account.encryptedServerData) {
    json[SERVER_KEY] = account.encryptedServerData;
  }

  fs.writeFileSync(storagePath, JSON.stringify(json, null, 2), 'utf8');
}

function resolveTraeAppPath(edition) {
  const saved = getTraePath();
  if (saved && fs.existsSync(saved)) return saved;

  const config = getPlatformConfig(edition);
  if (!config) throw new Error('未设置 Trae IDE 路径');

  if (process.platform === 'darwin') {
    const candidates = [
      config.defaultTraeApp,
      path.join(require('os').homedir(), 'Applications', `${config.clientDir}.app`),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  if (saved) throw new Error('Trae IDE 路径无效，请在设置中重新配置');
  throw new Error('未找到对应版本的 Trae IDE，请在设置中配置路径');
}

function openTrae(edition) {
  const appPath = resolveTraeAppPath(edition);
  if (process.platform === 'darwin') {
    spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn(appPath, [], { detached: true, stdio: 'ignore' }).unref();
  }
}

function clearLoginCache(traePath) {
  const globalStorage = path.join(traePath, 'User', 'globalStorage');
  removeIfExists(path.join(globalStorage, 'state.vscdb.backup'));
  removeIfExists(path.join(traePath, 'Cookies-journal'));
  removeIfExists(path.join(traePath, 'Network', 'Cookies-journal'));
}

async function switchTraeAccount(account) {
  const edition = editionOfAccount(account);
  killTrae(edition);

  const traePath = getTraeDataPath(edition);
  const machineId = account.machineId || generateMachineId();
  // 首次切换生成后回存账号库：每账号恒定一个设备指纹，避免在服务端累积设备数触发上限
  if (!account.machineId && account.id) setAccountMachineId(account.id, machineId);

  fs.writeFileSync(path.join(traePath, 'machineid'), machineId, 'utf8');
  clearLoginCache(traePath);

  const globalStorage = path.join(traePath, 'User', 'globalStorage');
  fs.mkdirSync(globalStorage, { recursive: true });
  const storagePath = path.join(globalStorage, 'storage.json');

  let json = {};
  if (fs.existsSync(storagePath)) {
    try {
      json = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    } catch {
      json = {};
    }
  }

  delete json[USERTAG_KEY];
  applyTelemetryIds(json, machineId);

  fs.writeFileSync(storagePath, JSON.stringify(json, null, 2), 'utf8');
  await writeTraeLoginInfo(traePath, account);

  syncSleep(0.5);

  try {
    openTrae(edition);
  } catch (err) {
    console.warn('自动打开 Trae 失败:', err.message);
  }

  return { machineId, edition };
}

function scanTraePath(edition) {
  const editions = targetEditions(edition);
  for (const ed of editions) {
    const config = getPlatformConfig(ed);
    if (!config) continue;

    if (process.platform === 'darwin') {
      const candidates = [
        config.defaultTraeApp,
        path.join(require('os').homedir(), 'Applications', `${config.clientDir}.app`),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
    }

    if (process.platform === 'win32' && fs.existsSync(config.defaultTraeApp)) {
      return config.defaultTraeApp;
    }
  }

  throw new Error('未找到对应版本的 Trae IDE，请手动设置路径');
}

async function readMachineInfo(edition) {
  const traePath = getTraeDataPath(edition);
  const machineIdPath = path.join(traePath, 'machineid');

  let machineId = null;
  if (fs.existsSync(machineIdPath)) {
    machineId = fs.readFileSync(machineIdPath, 'utf8').trim() || null;
  }

  const { json } = readStorageJson(traePath);
  let hasLogin = false;
  let loggedInEmail = null;
  const rawAuth = json?.[AUTH_KEY];
  if (rawAuth) {
    hasLogin = true;
    // AUTH_KEY 可能是明文 JSON（参考实现）或 dGMF 加密串（本工具写入），两种都尝试解析邮箱
    let authObj = null;
    try {
      authObj = JSON.parse(rawAuth);
    } catch {
      try {
        authObj = JSON.parse(await decryptString(rawAuth));
      } catch {
        /* 无法解密，仅标记已登录 */
      }
    }
    loggedInEmail = authObj?.account?.email || null;
  }

  return {
    edition,
    machineId,
    telemetryMachineId: json?.['telemetry.machineId'] || null,
    hasLogin,
    loggedInEmail,
    installed: fs.existsSync(traePath),
  };
}

function resetMachineId(edition) {
  killTrae(edition);

  const traePath = getTraeDataPath(edition);
  const machineId = generateMachineId();
  fs.writeFileSync(path.join(traePath, 'machineid'), machineId, 'utf8');

  const { json, storagePath } = readStorageJson(traePath);
  if (json) {
    applyTelemetryIds(json, machineId);
    fs.writeFileSync(storagePath, JSON.stringify(json, null, 2), 'utf8');
  }

  return { machineId, edition };
}

// 登录态缓存：Cookies / Local Storage / Session Storage / IndexedDB / Local State
// 会话数据（state.vscdb、ModularData、workspaceStorage）一律不动
function loginCachePaths(traePath) {
  return [
    path.join(traePath, 'Cookies'),
    path.join(traePath, 'Cookies-journal'),
    path.join(traePath, 'Network', 'Cookies'),
    path.join(traePath, 'Network', 'Cookies-journal'),
    path.join(traePath, 'Local State'),
    path.join(traePath, 'Local Storage'),
    path.join(traePath, 'Session Storage'),
    path.join(traePath, 'IndexedDB'),
  ];
}

function clearLoginState(edition) {
  killTrae(edition);

  const traePath = getTraeDataPath(edition);
  const { json, storagePath } = readStorageJson(traePath);

  let clearedAuth = false;
  if (json) {
    for (const key of LOGIN_STORAGE_KEYS) {
      if (key in json) {
        delete json[key];
        clearedAuth = true;
      }
    }
    if (clearedAuth) fs.writeFileSync(storagePath, JSON.stringify(json, null, 2), 'utf8');
  }

  let clearedCaches = 0;
  for (const p of loginCachePaths(traePath)) {
    if (!fs.existsSync(p)) continue;
    removeIfExists(p, fs.statSync(p).isDirectory());
    clearedCaches += 1;
  }

  return { edition, clearedAuth, clearedCaches };
}

module.exports = {
  switchTraeAccount,
  scanTraePath,
  getTraeDataPath,
  isTraeRunning,
  killTrae,
  findTraeAncestor,
  readMachineInfo,
  resetMachineId,
  clearLoginState,
  AUTH_KEY,
};
