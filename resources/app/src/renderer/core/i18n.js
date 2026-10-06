export function t(key, params) {
  return window.TraeHopI18n.t(key, params);
}

export function localeTag() {
  return window.TraeHopI18n.getLocale() === 'zh' ? 'zh-CN' : 'en-US';
}

export function listSep() {
  return window.TraeHopI18n.getLocale() === 'zh' ? '，' : ', ';
}

export function initI18n(locale) {
  return window.TraeHopI18n.initI18n(locale);
}

export function setLocale(locale) {
  return window.TraeHopI18n.setLocale(locale);
}

export function getLocale() {
  return window.TraeHopI18n.getLocale();
}

export function detectLocale() {
  return window.TraeHopI18n.detectLocale();
}

export function getI18nReady() {
  return window.TraeHopI18n.ready;
}
