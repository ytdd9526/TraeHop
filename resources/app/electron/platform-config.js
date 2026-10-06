const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_SUBDIRS = [
  'User/globalStorage',
  'User/workspaceStorage',
  'Local Storage',
  'ModularData',
  'logs',
  'ahanet',
  'DIPS',
  'DIPS-wal',
  'SharedStorage',
  'SharedStorage-wal',
  'Trust Tokens',
  'Trust Tokens-journal',
  'Cookies',
  'Cookies-journal',
  'Partitions',
  'Network Persistent State',
];

const WIN_APP_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'CachedData',
  'CachedExtensionVSIXs',
  'CachedConfigurations',
  'CachedProfilesData',
  'blob_storage',
  'Service Worker',
  'Session Storage',
  'WebStorage',
  'Crashpad',
];

// 双版本客户端注册表：目录名与 exe 名一致（TRAE SOLO CN.exe / Trae CN.exe / TRAE SOLO.exe / Trae.exe）
// dirs 按优先级排列（用户主用 SOLO 线）
const CLIENTS = {
  cn: {
    id: 'cn',
    label: '国内版',
    dirs: ['TRAE SOLO CN', 'Trae CN'],
    clientsLabel: 'TRAE SOLO CN / Trae CN',
  },
  intl: {
    id: 'intl',
    label: '国际版',
    dirs: ['TRAE SOLO', 'Trae'],
    clientsLabel: 'TRAE SOLO / Trae',
  },
};

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function localAppDataDir() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function resolveClientDir(edition) {
  const spec = CLIENTS[edition] || CLIENTS.cn;
  for (const dir of spec.dirs) {
    if (fs.existsSync(path.join(appDataDir(), dir))) return dir;
  }
  return spec.dirs[0];
}

function buildWinConfig(edition) {
  const spec = CLIENTS[edition] || CLIENTS.cn;
  const clientDir = resolveClientDir(edition);
  const appSupport = path.join(appDataDir(), clientDir);
  const exeDir = path.join(localAppDataDir(), 'Programs', clientDir);

  return {
    platform: 'win32',
    label: 'Windows',
    edition: spec.id,
    editionLabel: spec.label,
    clientsLabel: spec.clientsLabel,
    clientDir,
    clientExe: `${clientDir}.exe`,
    appSupportBase: appSupport,
    machineIdPath: path.join(appSupport, 'machineid'),
    defaultTraeApp: path.join(exeDir, `${clientDir}.exe`),
    dataSubdirs: DATA_SUBDIRS,
    cachePaths: [
      path.join(localAppDataDir(), clientDir),
      path.join(localAppDataDir(), 'trae-updater'),
      path.join(localAppDataDir(), 'com.trae.app'),
    ],
    winAppCacheDirs: WIN_APP_CACHE_DIRS,
    preferenceFiles: [],
  };
}

function buildMacConfig(edition) {
  const spec = CLIENTS[edition] || CLIENTS.cn;
  const home = os.homedir();
  const clientDir = resolveClientDir(edition);
  const appSupport = path.join(home, 'Library', 'Application Support', clientDir);

  return {
    platform: 'darwin',
    label: 'macOS',
    edition: spec.id,
    editionLabel: spec.label,
    clientsLabel: spec.clientsLabel,
    clientDir,
    clientExe: clientDir,
    appSupportBase: appSupport,
    machineIdPath: path.join(appSupport, 'machineid'),
    defaultTraeApp: `/Applications/${clientDir}.app`,
    dataSubdirs: DATA_SUBDIRS,
    cachePaths: [
      path.join(home, 'Library/Caches/com.trae.app'),
      path.join(home, 'Library/Caches/com.trae.app.ShipIt'),
      path.join(home, `Library/Caches/${clientDir}`),
    ],
    winAppCacheDirs: [],
    preferenceFiles: [],
  };
}

// edition: 'cn' | 'intl'；缺省走国内版（保持旧调用兼容）
function getPlatformConfig(edition) {
  const normalized = edition === 'intl' ? 'intl' : 'cn';
  if (process.platform === 'darwin') return buildMacConfig(normalized);
  if (process.platform === 'win32') return buildWinConfig(normalized);
  return null;
}

function listPlatformConfigs() {
  return [getPlatformConfig('cn'), getPlatformConfig('intl')];
}

function getScanPaths(config) {
  const paths = [config.appSupportBase, ...config.cachePaths];
  if (config.winAppCacheDirs.length) {
    for (const dir of config.winAppCacheDirs) {
      paths.push(path.join(config.appSupportBase, dir));
    }
  }
  return [...new Set(paths)];
}

module.exports = { getPlatformConfig, listPlatformConfigs, getScanPaths, CLIENTS };
