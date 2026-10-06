const fs = require('fs');
const path = require('path');
const os = require('os');

const CRED_FILENAMES = {
  win32: ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'],
  darwin: [process.env.HOME || os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'],
  linux: [process.env.HOME || os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'],
};

function getCredentialPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, ...CRED_FILENAMES.win32);
  }
  if (platform === 'darwin') {
    return path.join(...CRED_FILENAMES.darwin);
  }
  return path.join(...CRED_FILENAMES.linux);
}

function looksEncrypted(text) {
  if (!text) return false;
  const t = String(text).trim();
  return t.startsWith('$wbEncrypted') || /^(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(t);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeEndpoint(raw) {
  if (!raw) return null;
  let ep = String(raw).trim();
  if (!ep.startsWith('http://') && !ep.startsWith('https://')) {
    ep = `https://${ep}`;
  }
  return ep.replace(/\/$/, '');
}

function detectWorkbuddyCredentials() {
  const filePath = getCredentialPath();
  if (!fs.existsSync(filePath)) {
    return { found: false, filePath, encrypted: false, error: '凭据文件不存在' };
  }

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { found: false, filePath, encrypted: false, error: `读取失败: ${err.message}` };
  }

  if (looksEncrypted(text)) {
    return { found: true, filePath, encrypted: true, raw: text.slice(0, 200), error: '凭据已加密，请手动提取明文 Token' };
  }

  const parsed = safeParse(text);
  if (!parsed) {
    return { found: true, filePath, encrypted: false, raw: text.slice(0, 200), error: '无法解析凭据格式' };
  }

  const token = parsed.accessToken || parsed.token || parsed.access_token || null;
  const uid = parsed.uid || parsed.userId || parsed.user_id || parsed.id || null;
  const enterpriseId = parsed.enterpriseId || parsed.enterprise_id || parsed.tenantId || null;
  const domain = parsed.domain || parsed.teamDomain || parsed.team || null;
  const endpoint = normalizeEndpoint(parsed.endpoint || parsed.apiEndpoint || parsed.api_endpoint || parsed.host);

  if (!token || !uid || !endpoint) {
    return {
      found: true,
      filePath,
      encrypted: false,
      raw: text.slice(0, 200),
      error: `缺少关键字段: token=${!!token}, uid=${!!uid}, endpoint=${!!endpoint}`,
    };
  }

  return {
    found: true,
    filePath,
    encrypted: false,
    token,
    uid,
    endpoint,
    enterpriseId,
    domain,
  };
}

function parseWorkbuddyInfo(text) {
  if (looksEncrypted(text)) {
    return { encrypted: true, error: '凭据已加密，请手动提取明文 Token' };
  }
  const parsed = safeParse(text);
  if (!parsed) return { encrypted: false, error: '无法解析凭据格式' };
  return {
    encrypted: false,
    token: parsed.accessToken || parsed.token || parsed.access_token || null,
    uid: parsed.uid || parsed.userId || parsed.user_id || parsed.id || null,
    endpoint: normalizeEndpoint(parsed.endpoint || parsed.apiEndpoint || parsed.api_endpoint || parsed.host),
    enterpriseId: parsed.enterpriseId || parsed.enterprise_id || parsed.tenantId || null,
    domain: parsed.domain || parsed.teamDomain || parsed.team || null,
  };
}

module.exports = { detectWorkbuddyCredentials, parseWorkbuddyInfo, getCredentialPath };
