/**
 * Mask API key for UI responses (never send full key to the client).
 * @param {string} key
 */
export function maskApiKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `••••${s.slice(-4)}`;
}

/**
 * @param {object} cfg
 */
export function publicConfig(cfg = {}) {
  const apiKey = String(cfg.apiKey || "");
  return {
    station: cfg.station || "account",
    baseUrl: String(cfg.baseUrl || ""),
    apiKey: maskApiKey(apiKey),
    apiKeySet: !!apiKey,
    priceMul: Number(cfg.priceMul) > 0 ? Number(cfg.priceMul) : 1,
  };
}
