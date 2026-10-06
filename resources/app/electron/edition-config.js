
// 双版本配置：CN(trae.cn / api.trae.cn / 手机号注册) 与 INTL(trae.ai / grow-*.trae.ai / 邮箱注册)
// 数据来源：TRAE SOLO CN 与 TRAE SOLO(I18N) 的 product.json bootConfig.account/consoleHost 逆向

const EDITIONS = {
  cn: {
    id: 'cn',
    label: '国内版',
    loginHost: 'https://www.trae.cn',
    loginUrl: 'https://www.trae.cn/login',
    // trae.cn 无独立注册页：手机号验证码登录即注册
    signupMode: 'phone',
    // ExchangeToken / 签到 API 基础地址（CN 固定单区）
    apiBases: ['https://api.trae.cn'],
    siteCookiePattern: /trae\.cn/i,
  },
  intl: {
    id: 'intl',
    label: '国际版',
    loginHost: 'https://www.trae.ai',
    loginUrl: 'https://www.trae.ai/login',
    signupUrl: 'https://www.trae.ai/sign-up',
    signupMode: 'email',
    // 国际版按账号归属分 normal/SG/US 三集群，ExchangeToken 依次尝试
    apiBases: ['https://grow-normal.trae.ai', 'https://growsg-normal.trae.ai', 'https://grow-normal.traeapi.us'],
    siteCookiePattern: /trae\.ai/i,
  },
};

function getEdition(id) {
  return EDITIONS[id] || EDITIONS.cn;
}

function normalizeEdition(value) {
  return value === 'intl' ? 'intl' : 'cn';
}

module.exports = { EDITIONS, getEdition, normalizeEdition };
