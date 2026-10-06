const DEFAULT_TIMEOUT_MS = 15000;

async function fetchT(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

module.exports = { fetchT, DEFAULT_TIMEOUT_MS };
